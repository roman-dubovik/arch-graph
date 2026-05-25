/**
 * ProtectedController extends BaseController.
 * Adds multi-level inheritance for acceptance testing A6.
 */
import { BaseController } from './base.controller';

export abstract class ProtectedController<
    TEntity,
    TCreateDto,
    TUpdateDto,
> extends BaseController<TEntity, TCreateDto, TUpdateDto> {
    protected authMiddleware: string = 'default';
}
