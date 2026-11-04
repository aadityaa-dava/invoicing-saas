import { Body, Controller, Get, Post } from '@nestjs/common';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  createOrganizationSchema,
  type CreateOrganizationDto,
} from './organizations.dto';
import { OrganizationsService } from './organizations.service';

@Controller('orgs')
export class OrganizationsController {
  constructor(private readonly orgs: OrganizationsService) {}

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createOrganizationSchema))
    body: CreateOrganizationDto,
  ) {
    return this.orgs.create(user.id, body.name);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.orgs.listMine(user.id);
  }
}
