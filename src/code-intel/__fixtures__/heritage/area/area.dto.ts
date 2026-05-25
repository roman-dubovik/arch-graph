/**
 * DTOs for AreaEntity.
 */

export class AreaCreateDto {
    name: string;
    type: string;
}

export class AreaUpdateDto {
    name?: string;
    type?: string;
}
