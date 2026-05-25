/**
 * BaseController<TEntity, TCreateDto, TUpdateDto> — generic base with 5 CRUD methods.
 */

export abstract class BaseController<TEntity, TCreateDto, TUpdateDto> {
    async getAll(): Promise<TEntity[]> {
        return [];
    }

    async getOne(id: string): Promise<TEntity> {
        return null as unknown as TEntity;
    }

    async create(dto: TCreateDto): Promise<TEntity> {
        return null as unknown as TEntity;
    }

    async update(id: string, dto: TUpdateDto): Promise<TEntity> {
        return null as unknown as TEntity;
    }

    async delete(id: string): Promise<void> {
        // void
    }
}
