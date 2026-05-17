/**
 * Unit tests for OpenAPI YAML enrichment pass.
 *
 * All tests use in-memory YAML fixtures and a tmp directory for file-backed tests.
 * No actual beribuy/platform/insyra files are read.
 */

import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';

import type { GraphNode } from '../../core/types.js';
import { enrichEndpointsFromOpenApi, type OpenApiInfo } from './enrich-endpoints.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEndpointNode(
    method: string,
    path: string,
    methodName: string,
    extra?: Partial<GraphNode>,
): GraphNode {
    return {
        id: `endpoint:${method} ${path}`,
        kind: 'endpoint',
        label: `${method} ${path}`,
        meta: { methodName, controllerClass: 'TestController' },
        ...extra,
    };
}

async function writeTmpYaml(dir: string, filename: string, content: string): Promise<string> {
    const filePath = join(dir, filename);
    await writeFile(filePath, content, 'utf8');
    return filePath;
}

// ---------------------------------------------------------------------------
// AC-7-A: Happy path — 2 endpoints with Russian descriptions, operationId match
// ---------------------------------------------------------------------------

describe('enrichEndpointsFromOpenApi — AC-7-A happy path', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await mkdtemp(join(tmpdir(), 'ag-openapi-test-'));
        await mkdir(join(tmpDir, 'api'), { recursive: true });
    });

    it('matches 2 endpoints by operationId and populates meta.openapiInfo with Russian descriptions', async () => {
        const yamlContent = `
openapi: 3.0.0
paths:
  /categories:
    get:
      operationId: getCategories
      summary: Get categories
      description: Получение списка сущностей "Категория записи (поста)"
      tags:
        - Категории
      parameters:
        - name: limit
          in: query
          description: Максимальное количество записей
  /categories/{id}:
    post:
      operationId: createCategory
      summary: Create category
      description: Создание новой категории
      tags:
        - Категории
        - Create
`;
        await writeTmpYaml(join(tmpDir, 'api'), 'be-api.yaml', yamlContent);

        const nodes: GraphNode[] = [
            makeEndpointNode('GET', '/categories', 'getCategories'),
            makeEndpointNode('POST', '/categories/{id}', 'createCategory'),
            makeEndpointNode('DELETE', '/users', 'deleteUser'), // should NOT be matched
        ];

        const result = await enrichEndpointsFromOpenApi(nodes, tmpDir, ['api/*.yaml']);

        expect(result.diagnostics.filesProcessed).toBe(1);
        expect(result.diagnostics.endpointsMatched).toBe(2);
        expect(result.diagnostics.endpointsUnmatched).toHaveLength(0);
        expect(result.diagnostics.parseErrors).toHaveLength(0);

        // First node enriched
        const info1 = nodes[0]!.meta?.openapiInfo as OpenApiInfo;
        expect(info1.description).toBe('Получение списка сущностей "Категория записи (поста)"');
        expect(info1.summary).toBe('Get categories');
        expect(info1.tags).toEqual(['Категории']);
        expect(info1.paramSummary).toBe('limit: Максимальное количество записей');

        // Second node enriched
        const info2 = nodes[1]!.meta?.openapiInfo as OpenApiInfo;
        expect(info2.description).toBe('Создание новой категории');
        expect(info2.summary).toBe('Create category');
        expect(info2.tags).toEqual(['Категории', 'Create']);
        expect(info2.paramSummary).toBeUndefined(); // no parameters

        // Third node NOT enriched
        expect(nodes[2]!.meta?.openapiInfo).toBeUndefined();
    });

    it('preserves existing meta fields when adding openapiInfo', async () => {
        const yamlContent = `
openapi: 3.0.0
paths:
  /users:
    get:
      operationId: getUsers
      description: Получение пользователей
`;
        await writeTmpYaml(join(tmpDir, 'api'), 'api.yaml', yamlContent);

        const nodes: GraphNode[] = [
            {
                id: 'endpoint:GET /users',
                kind: 'endpoint',
                label: 'GET /users',
                meta: { methodName: 'getUsers', controllerClass: 'UserController', version: '1' },
            },
        ];

        await enrichEndpointsFromOpenApi(nodes, tmpDir, ['api/*.yaml']);

        // Existing meta fields preserved
        expect(nodes[0]!.meta?.controllerClass).toBe('UserController');
        expect(nodes[0]!.meta?.version).toBe('1');
        // New field added
        const info = nodes[0]!.meta?.openapiInfo as OpenApiInfo;
        expect(info.description).toBe('Получение пользователей');
    });
});

// ---------------------------------------------------------------------------
// AC-7-B: Unmatched operationId — recorded in diagnostics, no throw
// ---------------------------------------------------------------------------

describe('enrichEndpointsFromOpenApi — AC-7-B unmatched operationId', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await mkdtemp(join(tmpdir(), 'ag-openapi-test-'));
        await mkdir(join(tmpDir, 'api'), { recursive: true });
    });

    it('records YAML operations that have no matching endpoint node in diagnostics', async () => {
        const yamlContent = `
openapi: 3.0.0
paths:
  /nonexistent:
    get:
      operationId: getNonexistent
      description: This endpoint is not in the graph
  /alsoMissing:
    delete:
      operationId: deleteMissing
`;
        await writeTmpYaml(join(tmpDir, 'api'), 'api.yaml', yamlContent);

        const nodes: GraphNode[] = []; // no endpoint nodes at all

        const result = await enrichEndpointsFromOpenApi(nodes, tmpDir, ['api/*.yaml']);

        expect(result.diagnostics.endpointsMatched).toBe(0);
        expect(result.diagnostics.endpointsUnmatched).toHaveLength(2);
        expect(result.diagnostics.endpointsUnmatched[0]).toMatchObject({
            operationId: 'getNonexistent',
            method: 'get',
            path: '/nonexistent',
        });
        expect(result.diagnostics.endpointsUnmatched[1]).toMatchObject({
            operationId: 'deleteMissing',
            method: 'delete',
            path: '/alsoMissing',
        });

        // No throw happened — we got here
    });

    it('does not throw when operationId exists but no graph node matches (path also differs)', async () => {
        const yamlContent = `
openapi: 3.0.0
paths:
  /completely/different/path:
    get:
      operationId: findAllUsers
`;
        await writeTmpYaml(join(tmpDir, 'api'), 'api.yaml', yamlContent);

        // The graph has a node at GET /users — neither operationId nor path match
        const nodes: GraphNode[] = [
            makeEndpointNode('GET', '/users', 'getDifferentMethodName'),
        ];

        const result = await enrichEndpointsFromOpenApi(nodes, tmpDir, ['api/*.yaml']);

        expect(result.diagnostics.endpointsUnmatched).toHaveLength(1);
        expect(result.diagnostics.endpointsUnmatched[0]).toMatchObject({
            operationId: 'findAllUsers',
            method: 'get',
            path: '/completely/different/path',
        });
        expect(result.diagnostics.endpointsMatched).toBe(0);
        expect(nodes[0]!.meta?.openapiInfo).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// AC-7-C: Fallback matcher — no operationId, (method, path) match
// ---------------------------------------------------------------------------

describe('enrichEndpointsFromOpenApi — AC-7-C fallback (method, path) match', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await mkdtemp(join(tmpdir(), 'ag-openapi-test-'));
        await mkdir(join(tmpDir, 'api'), { recursive: true });
    });

    it('falls back to (method, path) match when operationId is absent', async () => {
        const yamlContent = `
openapi: 3.0.0
paths:
  /products:
    get:
      summary: List products
      description: Получение списка товаров
      tags:
        - Products
`;
        // Note: no operationId field
        await writeTmpYaml(join(tmpDir, 'api'), 'api.yaml', yamlContent);

        const nodes: GraphNode[] = [
            makeEndpointNode('GET', '/products', 'listProducts'),
        ];

        const result = await enrichEndpointsFromOpenApi(nodes, tmpDir, ['api/*.yaml']);

        expect(result.diagnostics.endpointsMatched).toBe(1);
        expect(result.diagnostics.endpointsUnmatched).toHaveLength(0);

        const info = nodes[0]!.meta?.openapiInfo as OpenApiInfo;
        expect(info.description).toBe('Получение списка товаров');
        expect(info.summary).toBe('List products');
        expect(info.tags).toEqual(['Products']);
    });

    it('falls back to (method, path) when operationId does not match any node', async () => {
        const yamlContent = `
openapi: 3.0.0
paths:
  /orders:
    post:
      operationId: someRandomOperationId
      description: Создание заказа
`;
        await writeTmpYaml(join(tmpDir, 'api'), 'api.yaml', yamlContent);

        const nodes: GraphNode[] = [
            makeEndpointNode('POST', '/orders', 'createOrder'),
        ];

        // operationId 'someRandomOperationId' != 'createOrder', so should fall to path match
        const result = await enrichEndpointsFromOpenApi(nodes, tmpDir, ['api/*.yaml']);

        expect(result.diagnostics.endpointsMatched).toBe(1);
        const info = nodes[0]!.meta?.openapiInfo as OpenApiInfo;
        expect(info.description).toBe('Создание заказа');
    });
});

// ---------------------------------------------------------------------------
// AC-7-D: Parse error on malformed YAML — recorded in parseErrors, others still processed
// ---------------------------------------------------------------------------

describe('enrichEndpointsFromOpenApi — AC-7-D parse error handling', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await mkdtemp(join(tmpdir(), 'ag-openapi-test-'));
        await mkdir(join(tmpDir, 'api'), { recursive: true });
    });

    it('records parse error for malformed YAML and continues processing other files', async () => {
        const malformedYaml = `
openapi: 3.0.0
paths:
  /bad: [unclosed bracket
  invalid: yaml: content: here:
`;
        const validYaml = `
openapi: 3.0.0
paths:
  /users:
    get:
      operationId: getUsers
      description: Получение пользователей
`;
        await writeTmpYaml(join(tmpDir, 'api'), 'bad.yaml', malformedYaml);
        await writeTmpYaml(join(tmpDir, 'api'), 'good.yaml', validYaml);

        const nodes: GraphNode[] = [
            makeEndpointNode('GET', '/users', 'getUsers'),
        ];

        const result = await enrichEndpointsFromOpenApi(nodes, tmpDir, ['api/*.yaml']);

        // One file errored, one processed
        expect(result.diagnostics.parseErrors).toHaveLength(1);
        expect(result.diagnostics.parseErrors[0]!.file).toMatch(/bad\.yaml$/);

        // Good file was still processed
        expect(result.diagnostics.filesProcessed).toBe(1);
        expect(result.diagnostics.endpointsMatched).toBe(1);

        const info = nodes[0]!.meta?.openapiInfo as OpenApiInfo;
        expect(info.description).toBe('Получение пользователей');
    });
});

// ---------------------------------------------------------------------------
// AC-7-E: No YAML files — silent no-op
// ---------------------------------------------------------------------------

describe('enrichEndpointsFromOpenApi — AC-7-E no YAML files', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await mkdtemp(join(tmpdir(), 'ag-openapi-test-'));
        // Intentionally DO NOT create api/ dir
    });

    it('returns zero diagnostics when no files match the globs', async () => {
        const nodes: GraphNode[] = [
            makeEndpointNode('GET', '/users', 'getUsers'),
        ];

        const result = await enrichEndpointsFromOpenApi(nodes, tmpDir, ['api/*.yaml', 'api/*.yml']);

        expect(result.diagnostics.filesProcessed).toBe(0);
        expect(result.diagnostics.endpointsMatched).toBe(0);
        expect(result.diagnostics.endpointsUnmatched).toHaveLength(0);
        expect(result.diagnostics.parseErrors).toHaveLength(0);

        // Nodes unchanged
        expect(nodes[0]!.meta?.openapiInfo).toBeUndefined();
    });

    it('is a silent no-op with default globs when no YAML files exist', async () => {
        const nodes: GraphNode[] = [makeEndpointNode('POST', '/items', 'createItem')];

        // No globs passed — uses defaults
        const result = await enrichEndpointsFromOpenApi(nodes, tmpDir);

        expect(result.diagnostics.filesProcessed).toBe(0);
        expect(result.diagnostics.endpointsMatched).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Additional edge cases
// ---------------------------------------------------------------------------

describe('enrichEndpointsFromOpenApi — edge cases', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await mkdtemp(join(tmpdir(), 'ag-openapi-test-'));
        await mkdir(join(tmpDir, 'api'), { recursive: true });
    });

    it('handles parameters without descriptions (includes name only in paramSummary)', async () => {
        const yamlContent = `
openapi: 3.0.0
paths:
  /items/{id}:
    get:
      operationId: getItem
      parameters:
        - name: id
          in: path
        - name: locale
          in: query
          description: Языковой код (ru, en)
`;
        await writeTmpYaml(join(tmpDir, 'api'), 'api.yaml', yamlContent);

        const nodes: GraphNode[] = [makeEndpointNode('GET', '/items/{id}', 'getItem')];

        await enrichEndpointsFromOpenApi(nodes, tmpDir, ['api/*.yaml']);

        const info = nodes[0]!.meta?.openapiInfo as OpenApiInfo;
        // id has no description, locale has description
        expect(info.paramSummary).toBe('id; locale: Языковой код (ru, en)');
    });

    it('handles operations with no description/summary/tags — produces minimal info', async () => {
        const yamlContent = `
openapi: 3.0.0
paths:
  /ping:
    get:
      operationId: ping
`;
        await writeTmpYaml(join(tmpDir, 'api'), 'api.yaml', yamlContent);

        const nodes: GraphNode[] = [makeEndpointNode('GET', '/ping', 'ping')];

        const result = await enrichEndpointsFromOpenApi(nodes, tmpDir, ['api/*.yaml']);

        expect(result.diagnostics.endpointsMatched).toBe(1);
        const info = nodes[0]!.meta?.openapiInfo as OpenApiInfo;
        // Empty info — all fields undefined
        expect(info.description).toBeUndefined();
        expect(info.summary).toBeUndefined();
        expect(info.tags).toBeUndefined();
        expect(info.paramSummary).toBeUndefined();
    });

    it('skips non-HTTP method keys in path item (e.g. summary, parameters)', async () => {
        const yamlContent = `
openapi: 3.0.0
paths:
  /users:
    summary: User operations
    parameters:
      - name: global
    get:
      operationId: listUsers
      description: Список пользователей
`;
        await writeTmpYaml(join(tmpDir, 'api'), 'api.yaml', yamlContent);

        const nodes: GraphNode[] = [makeEndpointNode('GET', '/users', 'listUsers')];

        const result = await enrichEndpointsFromOpenApi(nodes, tmpDir, ['api/*.yaml']);

        // Only 1 match (GET), summary/parameters keys ignored
        expect(result.diagnostics.endpointsMatched).toBe(1);
        expect(result.diagnostics.endpointsUnmatched).toHaveLength(0);
    });

    it('handles multiple YAML files and aggregates diagnostics', async () => {
        const yaml1 = `
openapi: 3.0.0
paths:
  /a:
    get:
      operationId: getA
      description: Описание A
`;
        const yaml2 = `
openapi: 3.0.0
paths:
  /b:
    post:
      operationId: createB
      description: Описание B
`;
        await writeTmpYaml(join(tmpDir, 'api'), 'a.yaml', yaml1);
        await writeTmpYaml(join(tmpDir, 'api'), 'b.yaml', yaml2);

        const nodes: GraphNode[] = [
            makeEndpointNode('GET', '/a', 'getA'),
            makeEndpointNode('POST', '/b', 'createB'),
        ];

        const result = await enrichEndpointsFromOpenApi(nodes, tmpDir, ['api/*.yaml']);

        expect(result.diagnostics.filesProcessed).toBe(2);
        expect(result.diagnostics.endpointsMatched).toBe(2);
        expect((nodes[0]!.meta?.openapiInfo as OpenApiInfo).description).toBe('Описание A');
        expect((nodes[1]!.meta?.openapiInfo as OpenApiInfo).description).toBe('Описание B');
    });
});
