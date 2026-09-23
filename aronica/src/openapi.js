// OpenAPI 3.1 generated from the same tool definitions (usable as a Custom GPT
// Action, xAI/OpenAI function source, or any HTTP client).
import { TOOLS } from './connector.js';
import { BASE_URL } from './jobs.js';

export function openApiSpec() {
  const paths = {};
  for (const t of TOOLS) {
    const props = t.input.properties ?? {};
    const pathParams = [...t.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    const rest = Object.fromEntries(Object.entries(props).filter(([k]) => !pathParams.includes(k)));
    const required = (t.input.required ?? []).filter((k) => !pathParams.includes(k));
    const op = {
      operationId: t.name,
      summary: t.description.split('. ')[0],
      description: t.description,
      parameters: pathParams.map((p) => ({ name: p, in: 'path', required: true, schema: { type: 'string' } })),
      responses: {
        200: { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } },
        409: { description: 'Conflict / no supply (honest empty state)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        422: { description: 'Unsupported task, city or skill (fail closed)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    };
    if (t.method === 'GET') {
      for (const [k, s] of Object.entries(rest)) {
        if (s.type === 'object') continue;
        op.parameters.push({ name: k, in: 'query', required: required.includes(k), schema: s });
      }
    } else if (Object.keys(rest).length) {
      op.requestBody = {
        required: true,
        content: { 'application/json': { schema: { type: 'object', properties: rest, ...(required.length ? { required } : {}) } } },
      };
    }
    paths[t.path] ??= {};
    paths[t.path][t.method.toLowerCase()] = op;
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Aronica Agent Connector',
      version: '0.1.0',
      description: 'Agent→Human dispatch for Milano. AI agents hire verified people for physical field-proof tasks via live negotiation with supplier agents; a human confirms with one tap; work is dispatched immediately.',
    },
    servers: [{ url: BASE_URL() }],
    security: [{ bearer: [] }],
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'Aronica API key (demo: ak_demo_milano)' } },
      schemas: {
        Error: {
          type: 'object',
          properties: { error: { type: 'string' }, message: { type: 'string' }, detail: { type: 'string' } },
        },
      },
    },
    paths,
  };
}
