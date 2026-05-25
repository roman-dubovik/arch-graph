/**
 * EngagementController extends BaseController.
 * 3 delegation methods + 2 augmented methods.
 */
import { Get, Post, Put, Delete } from '../_decorators';
import { BaseController } from '../base/base.controller';

interface EngagementEntity {
    id: string;
    areaId: string;
}

interface EngagementCreateDto {
    areaId: string;
}

interface EngagementUpdateDto {
    areaId?: string;
}

export class EngagementController extends BaseController<
    EngagementEntity,
    EngagementCreateDto,
    EngagementUpdateDto
> {
    @Get('/engagements')
    async getAll(): Promise<EngagementEntity[]> {
        return super.getAll();
    }

    @Get('/engagements/:id')
    async getOne(id: string): Promise<EngagementEntity> {
        return super.getOne(id);
    }

    @Post('/engagements')
    async create(dto: EngagementCreateDto): Promise<EngagementEntity> {
        console.log('Creating engagement with dto:', dto);
        return super.create(dto);
    }

    @Put('/engagements/:id')
    async update(id: string, dto: EngagementUpdateDto): Promise<EngagementEntity> {
        if (!dto.areaId) {
            throw new Error('areaId is required');
        }
        return super.update(id, dto);
    }

    @Delete('/engagements/:id')
    async delete(id: string): Promise<void> {
        return super.delete(id);
    }
}
