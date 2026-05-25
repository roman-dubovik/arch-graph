/**
 * AreaController extends BaseController<AreaEntity, AreaCreateDto, AreaUpdateDto>.
 * All 5 methods are pure-delegation with NestJS decorators.
 */
import { Get, Post, Put, Delete } from '../_decorators';
import { BaseController } from '../base/base.controller';
import { AreaCreateDto, AreaUpdateDto } from './area.dto';
import { AreaEntity } from './area.entity';

export class AreaController extends BaseController<
    AreaEntity,
    AreaCreateDto,
    AreaUpdateDto
> {
    @Get('/areas')
    async getAll(): Promise<AreaEntity[]> {
        return super.getAll();
    }

    @Get('/areas/:id')
    async getOne(id: string): Promise<AreaEntity> {
        return super.getOne(id);
    }

    @Post('/areas')
    async create(dto: AreaCreateDto): Promise<AreaEntity> {
        return super.create(dto);
    }

    @Put('/areas/:id')
    async update(id: string, dto: AreaUpdateDto): Promise<AreaEntity> {
        return super.update(id, dto);
    }

    @Delete('/areas/:id')
    async delete(id: string): Promise<void> {
        return super.delete(id);
    }
}
