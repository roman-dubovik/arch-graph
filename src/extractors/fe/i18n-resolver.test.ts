/**
 * Tests for src/extractors/fe/i18n-resolver.ts
 *
 * Covers AC-B1..B4, AC-B7:
 *   B1 — next-intl: resolves t('common.apply') → "Применить" from ru.json
 *   B2 — react-i18next: resolves t('common.cancel') → "Отмена" from ru.json
 *   B3 — no i18n library imported → empty array, no error
 *   B4 — key missing in messages → silently skipped (partial results returned)
 *   B7 — covers all 4 paths (next-intl resolved, react-i18next resolved,
 *         library absent, key missing)
 */

import { describe, expect, it } from 'vitest';
import { Project } from 'ts-morph';
import { extractI18nStringsForFile, loadMessagesFromJson } from './i18n-resolver.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProject(files: Record<string, string>): Project {
    const project = new Project({
        useInMemoryFileSystem: true,
        compilerOptions: { target: 99, module: 99, jsx: 2 /* React */, strict: false },
    });
    for (const [path, src] of Object.entries(files)) {
        project.createSourceFile(path, src);
    }
    return project;
}

const RU_MESSAGES = {
    common: { apply: 'Применить', cancel: 'Отмена', title: 'Заголовок' },
    buttons: { save: 'Сохранить' },
};

// ---------------------------------------------------------------------------
// AC-B1: next-intl resolved
// ---------------------------------------------------------------------------
describe('i18n-resolver — next-intl (AC-B1)', () => {
    it('resolves t("common.apply") → "Применить"', () => {
        const project = makeProject({
            '/root/Button.tsx': `
                import { useTranslations } from 'next-intl';
                export const Button = () => {
                    const t = useTranslations();
                    return <button>{t('common.apply')}</button>;
                };
            `,
        });
        const sf = project.getSourceFileOrThrow('/root/Button.tsx');
        const result = extractI18nStringsForFile(sf, RU_MESSAGES);
        expect(result).toContain('Применить');
    });

    it('resolves multiple keys from the same file', () => {
        const project = makeProject({
            '/root/MultiKey.tsx': `
                import { useTranslations } from 'next-intl';
                export const MultiKey = () => {
                    const t = useTranslations();
                    return <div><span>{t('common.apply')}</span><span>{t('buttons.save')}</span></div>;
                };
            `,
        });
        const sf = project.getSourceFileOrThrow('/root/MultiKey.tsx');
        const result = extractI18nStringsForFile(sf, RU_MESSAGES);
        expect(result).toContain('Применить');
        expect(result).toContain('Сохранить');
    });

    it('resolves useTranslations("namespace") with prefixed keys', () => {
        const project = makeProject({
            '/root/NsButton.tsx': `
                import { useTranslations } from 'next-intl';
                export const NsButton = () => {
                    const t = useTranslations('common');
                    return <button>{t('apply')}</button>;
                };
            `,
        });
        const sf = project.getSourceFileOrThrow('/root/NsButton.tsx');
        const result = extractI18nStringsForFile(sf, RU_MESSAGES);
        expect(result).toContain('Применить');
    });
});

// ---------------------------------------------------------------------------
// AC-B2: react-i18next resolved
// ---------------------------------------------------------------------------
describe('i18n-resolver — react-i18next (AC-B2)', () => {
    it('resolves t("common.cancel") → "Отмена"', () => {
        const project = makeProject({
            '/root/CancelBtn.tsx': `
                import { useTranslation } from 'react-i18next';
                export const CancelBtn = () => {
                    const { t } = useTranslation();
                    return <button>{t('common.cancel')}</button>;
                };
            `,
        });
        const sf = project.getSourceFileOrThrow('/root/CancelBtn.tsx');
        const result = extractI18nStringsForFile(sf, RU_MESSAGES);
        expect(result).toContain('Отмена');
    });

    it('resolves multiple react-i18next keys', () => {
        const project = makeProject({
            '/root/Multi.tsx': `
                import { useTranslation } from 'react-i18next';
                export const Multi = () => {
                    const { t } = useTranslation();
                    return <div>{t('common.apply')}{t('buttons.save')}</div>;
                };
            `,
        });
        const sf = project.getSourceFileOrThrow('/root/Multi.tsx');
        const result = extractI18nStringsForFile(sf, RU_MESSAGES);
        expect(result).toContain('Применить');
        expect(result).toContain('Сохранить');
    });
});

// ---------------------------------------------------------------------------
// AC-B3: no i18n library → empty array, no error
// ---------------------------------------------------------------------------
describe('i18n-resolver — no i18n library (AC-B3)', () => {
    it('returns empty array when no i18n import present', () => {
        const project = makeProject({
            '/root/Plain.tsx': `
                export const Plain = () => <div>hello</div>;
            `,
        });
        const sf = project.getSourceFileOrThrow('/root/Plain.tsx');
        const result = extractI18nStringsForFile(sf, RU_MESSAGES);
        expect(result).toEqual([]);
    });

    it('returns empty array for unrecognised i18n library', () => {
        const project = makeProject({
            '/root/Custom.tsx': `
                import { t } from 'my-custom-i18n';
                export const Custom = () => <div>{t('foo.bar')}</div>;
            `,
        });
        const sf = project.getSourceFileOrThrow('/root/Custom.tsx');
        const result = extractI18nStringsForFile(sf, RU_MESSAGES);
        expect(result).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// AC-B4: key missing in message file → silently skipped, no throw
// ---------------------------------------------------------------------------
describe('i18n-resolver — missing key (AC-B4)', () => {
    it('skips unknown key silently and returns resolved keys', () => {
        const project = makeProject({
            '/root/Mixed.tsx': `
                import { useTranslations } from 'next-intl';
                export const Mixed = () => {
                    const t = useTranslations();
                    return <div>{t('common.apply')}{t('nonexistent.key')}</div>;
                };
            `,
        });
        const sf = project.getSourceFileOrThrow('/root/Mixed.tsx');
        const result = extractI18nStringsForFile(sf, RU_MESSAGES);
        // Should contain the resolved key, not throw on the missing one
        expect(result).toContain('Применить');
        // Missing key should not appear
        expect(result).not.toContain('nonexistent.key');
        expect(result.length).toBe(1);
    });

    it('returns empty array when all keys are missing', () => {
        const project = makeProject({
            '/root/AllMissing.tsx': `
                import { useTranslations } from 'next-intl';
                export const AllMissing = () => {
                    const t = useTranslations();
                    return <div>{t('missing.one')}{t('missing.two')}</div>;
                };
            `,
        });
        const sf = project.getSourceFileOrThrow('/root/AllMissing.tsx');
        const result = extractI18nStringsForFile(sf, RU_MESSAGES);
        expect(result).toEqual([]);
    });

    it('does not throw on empty messages object', () => {
        const project = makeProject({
            '/root/EmptyMessages.tsx': `
                import { useTranslation } from 'react-i18next';
                export const EmptyMessages = () => {
                    const { t } = useTranslation();
                    return <div>{t('common.apply')}</div>;
                };
            `,
        });
        const sf = project.getSourceFileOrThrow('/root/EmptyMessages.tsx');
        expect(() => extractI18nStringsForFile(sf, {})).not.toThrow();
        const result = extractI18nStringsForFile(sf, {});
        expect(result).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// loadMessagesFromJson — direct unit tests
// ---------------------------------------------------------------------------
describe('loadMessagesFromJson', () => {
    it('parses flat JSON correctly', () => {
        const json = JSON.stringify({ foo: 'bar', baz: 'qux' });
        const result = loadMessagesFromJson(json);
        expect(result).toEqual({ foo: 'bar', baz: 'qux' });
    });

    it('parses nested JSON correctly', () => {
        const json = JSON.stringify({ common: { apply: 'Применить' } });
        const result = loadMessagesFromJson(json);
        expect(result).toEqual({ common: { apply: 'Применить' } });
    });

    it('returns empty object for invalid JSON', () => {
        const result = loadMessagesFromJson('not json {{');
        expect(result).toEqual({});
    });
});
