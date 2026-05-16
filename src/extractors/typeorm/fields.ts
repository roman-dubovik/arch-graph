/**
 * TypeORM entity field extractor — placeholder for Variant 2, Task B4.
 *
 * Walks `@Entity`-decorated classes and collects `@Column*` decorated properties,
 * emitting db-entity-field nodes and entity-has-field edges.
 *
 * Implementation: B4 (real extractor extending typeorm/entity-index.ts).
 */

import type { TypeOrmEntity } from '../../core/types.js';

export interface EntityFieldSite {
    /** Parent entity class name. */
    entityClass: string;
    /** Parent table name. */
    tableName: string;
    /** Field property name. */
    fieldName: string;
    /** SQL column type (string). */
    fieldType: string;
    /** Is the column nullable. */
    nullable: boolean;
}

export interface DbEntityFieldExtractResult {
    fields: EntityFieldSite[];
    diagnostics: Array<{ file: string; line: number; message: string }>;
}

/**
 * Extract db-entity-field sites from TypeORM entity index.
 *
 * This is a placeholder stub returning empty results. The full implementation
 * will extend src/extractors/typeorm/entity-index.ts in B4.
 */
export function extractEntityFields(_entities: TypeOrmEntity[]): DbEntityFieldExtractResult {
    return {
        fields: [],
        diagnostics: [],
    };
}
