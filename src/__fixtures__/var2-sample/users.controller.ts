import { Controller, Get, Post, Patch, Delete, Body, Param } from '@nestjs/common';

@Controller('users')
export class UsersController {
    @Get()
    findAll() {
        return [];
    }

    @Get(':id')
    findOne(@Param('id') id: string) {
        return { id };
    }

    @Post()
    create(@Body() body: unknown) {
        return body;
    }

    @Patch(':id')
    update(@Param('id') id: string, @Body() body: unknown) {
        return { id, ...body as object };
    }

    @Delete(':id')
    remove(@Param('id') id: string) {
        return { deleted: id };
    }
}
