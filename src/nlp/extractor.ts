// src/nlp/extractor.ts
// Claude Haiku NLP extractor — extracts entities and decisions from conversation turns

import Anthropic from '@anthropic-ai/sdk';
import type { GraphDB } from '../graph/kuzu.js';
import type { GraphNode, GraphEdge } from '../graph/schema.js';
import { WEIGHT_INITIAL } from '../graph/schema.js';

interface ExtractedEntity {
  label: string;
  type: 'decision' | 'bug' | 'concept' | 'pattern';
  content?: string;
  related?: string[];
}

interface ExtractionResult {
  entities: ExtractedEntity[];
  sessionId?: string;
}

const SYSTEM_PROMPT = `You are a knowledge graph entity extractor. Extract structured entities from developer conversation turns.

Return ONLY valid JSON with this schema:
{
  "entities": [
    {
      "label": "short name for the entity (max 60 chars)",
      "type": "decision|bug|concept|pattern",
      "content": "1-2 sentence summary",
      "related": ["list of related concept labels mentioned nearby"]
    }
  ]
}

Entity type guide:
- "decision": architectural or implementation choices ("use JWT not sessions", "switch to PostgreSQL")
- "bug": bug reports or errors (#312, CORS error, null pointer)
- "concept": domain concepts, technologies, tools (Polygon, IPFS, WebRTC, Zod)
- "pattern": recurring practices ("always validate with Zod", "use early returns")

Rules:
- Extract 0-5 entities per turn (quality over quantity)
- Ignore trivial phrases ("yes", "ok", "let me check")
- For decisions: capture WHY when mentioned
- Return empty entities array if nothing meaningful to extract`;

export class NLPExtractor {
  private client: Anthropic | null = null;
  private db: GraphDB;
  private enabled: boolean;

  constructor(db: GraphDB) {
    this.db = db;
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    this.enabled = !!apiKey;
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
      console.error('[NLPExtractor] Enabled (Claude Haiku)');
    } else {
      console.error('[NLPExtractor] Disabled — set ANTHROPIC_API_KEY to enable entity extraction');
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async extract(role: string, content: string, sessionId?: string): Promise<ExtractedEntity[]> {
    if (!this.enabled || !this.client) return [];
    if (content.trim().length < 20) return [];

    try {
      const response = await this.client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 512,
        messages: [
          {
            role: 'user',
            content: `Extract entities from this ${role} message:\n\n${content.slice(0, 2000)}`,
          },
        ],
        system: SYSTEM_PROMPT,
      });

      const rawText = response.content[0]?.type === 'text' ? response.content[0].text : '{}';
      // Extract JSON from response (handle markdown code fences)
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return [];

      const result = JSON.parse(jsonMatch[0]) as ExtractionResult;
      const entities = result.entities ?? [];

      // Upsert entities into graph
      for (const entity of entities) {
        const nodeId = `${entity.type}:${entity.label.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 80)}`;

        const node: GraphNode = {
          id: nodeId,
          type: entity.type,
          label: entity.label,
          content: entity.content,
          metadata: { source: 'nlp', role, sessionId },
        };
        await this.db.upsertNode(node);

        // Link to session if available
        if (sessionId) {
          const sessionNodeId = `session:${sessionId}`;
          const sessionEdge: GraphEdge = {
            sourceId: nodeId,
            targetId: sessionNodeId,
            type: 'decided_in',
            weight: WEIGHT_INITIAL,
            accessCount: 1,
            archived: false,
          };
          await this.db.upsertEdge(sessionEdge);
        }

        // Link related concepts
        for (const relatedLabel of entity.related ?? []) {
          const relatedId = `concept:${relatedLabel.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 80)}`;
          const relatedNode: GraphNode = {
            id: relatedId,
            type: 'concept',
            label: relatedLabel,
          };
          await this.db.upsertNode(relatedNode);

          const relEdge: GraphEdge = {
            sourceId: nodeId,
            targetId: relatedId,
            type: 'mentions',
            weight: WEIGHT_INITIAL,
            accessCount: 1,
            archived: false,
          };
          await this.db.upsertEdge(relEdge);
        }
      }

      return entities;
    } catch (err) {
      console.error('[NLPExtractor] Extraction failed:', err);
      return [];
    }
  }
}
