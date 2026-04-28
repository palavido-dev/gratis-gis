import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';
import { FormsController } from './forms.controller.js';
import { FormsService } from './forms.service.js';

/**
 * Form submission storage + access (#131). The form item itself
 * (the schema) lives in the Items module; this module only owns
 * captured responses.
 */
@Module({
  imports: [PrismaModule],
  controllers: [FormsController],
  providers: [FormsService],
  exports: [FormsService],
})
export class FormsModule {}
