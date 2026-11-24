// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The off-site backup page shows the folder rule the server checks
 * (letters A-Z and a-z, digits 0-9, ".", "_", "-", "/" between
 * folders), in every locale, next to the folder field.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { en } from './i18n/messages/en';
import { es } from './i18n/messages/es';
import { fr } from './i18n/messages/fr';
import { de } from './i18n/messages/de';
import { ptBR } from './i18n/messages/pt-BR';

type Tree = { adminBackup: { offsite: { folderHint: string } } };
const CATALOGS: Record<string, unknown> = { en, es, fr, de, 'pt-BR': ptBR };

describe('off-site folder hint', () => {
  it.each(Object.keys(CATALOGS))('%s states the folder rule', (locale) => {
    const hint = (CATALOGS[locale] as Tree).adminBackup.offsite.folderHint;
    expect(hint).toContain('A-Z');
    expect(hint).toContain('a-z');
    expect(hint).toContain('0-9');
    expect(hint).toContain('/');
    expect(hint).toContain('gratisgis-main/');
  });

  it('is shown under the folder field', () => {
    const page = fs.readFileSync(
      path.join(__dirname, '..', 'app', 'admin', 'backup', 'offsite-section.tsx'),
      'utf8',
    );
    expect(page).toContain("t('adminBackup.offsite.folderHint')");
  });
});
