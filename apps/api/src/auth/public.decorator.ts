import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

// Every route requires authentication unless it is marked with @Public().
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
