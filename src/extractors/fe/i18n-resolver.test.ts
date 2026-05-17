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
 *
 * Review round 1 additions:
 *   P0-2  — variable namespace arg skipped + WARNING emitted
 *   P1-A  — aliased t binding detected
 *   P1-B  — dynamic key warning fires once per file
 *   P1-D  — loadMessagesFromJson discriminated union
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
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
// loadMessagesFromJson — direct unit tests (P1-D: discriminated union)
// ---------------------------------------------------------------------------
describe('loadMessagesFromJson', () => {
    it('parses flat JSON correctly', () => {
        const json = JSON.stringify({ foo: 'bar', baz: 'qux' });
        const result = loadMessagesFromJson(json);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.messages).toEqual({ foo: 'bar', baz: 'qux' });
        }
    });

    it('parses nested JSON correctly', () => {
        const json = JSON.stringify({ common: { apply: 'Применить' } });
        const result = loadMessagesFromJson(json);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.messages).toEqual({ common: { apply: 'Применить' } });
        }
    });

    it('returns ok:false for invalid JSON (P1-D)', () => {
        const result = loadMessagesFromJson('not json {{');
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toBeTruthy();
        }
    });

    it('returns ok:false for non-object JSON (array)', () => {
        const result = loadMessagesFromJson('["a","b"]');
        expect(result.ok).toBe(false);
    });

    it('returns ok:true with empty messages for empty object JSON', () => {
        const result = loadMessagesFromJson('{}');
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.messages).toEqual({});
        }
    });
});

// ---------------------------------------------------------------------------
// P0-2: variable namespace skipped + WARNING emitted
// ---------------------------------------------------------------------------
describe('i18n-resolver — variable namespace (P0-2)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('falls back to bare key and emits WARNING when useTranslations receives a variable', () => {
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

        const project = makeProject({
            '/root/VarNs.tsx': `
                import { useTranslations } from 'next-intl';
                const NAMESPACE_CONST = 'common';
                export const VarNs = () => {
                    const t = useTranslations(NAMESPACE_CONST);
                    return <button>{t('apply')}</button>;
                };
            `,
        });
        const sf = project.getSourceFileOrThrow('/root/VarNs.tsx');

        // With namespace skipped, 'apply' resolves as bare key — not found in RU_MESSAGES
        // (RU_MESSAGES has common.apply, not bare apply). Result may be empty, but no throw.
        expect(() => extractI18nStringsForFile(sf, RU_MESSAGES)).not.toThrow();

        // WARNING must have been emitted
        const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
        const warnCall = calls.find((s) => s.includes('non-literal namespace argument'));
        expect(warnCall).toBeDefined();
        expect(warnCall).toContain('[arch-graph fe-i18n] WARNING');
    });
});

// ---------------------------------------------------------------------------
// P1-A: aliased t binding detected
// ---------------------------------------------------------------------------
describe('i18n-resolver — aliased t binding (P1-A)', () => {
    it('resolves keys when t is aliased as translate via useTranslation', () => {
        const project = makeProject({
            '/root/Aliased.tsx': `
                import { useTranslation } from 'react-i18next';
                export const Aliased = () => {
                    const { t: translate } = useTranslation();
                    return <button>{translate('common.apply')}</button>;
                };
            `,
        });
        const sf = project.getSourceFileOrThrow('/root/Aliased.tsx');
        const result = extractI18nStringsForFile(sf, RU_MESSAGES);
        expect(result).toContain('Применить');
    });

    it('resolves keys when t is aliased via useTranslations (next-intl)', () => {
        const project = makeProject({
            '/root/AliasedIntl.tsx': `
                import { useTranslations } from 'next-intl';
                export const AliasedIntl = () => {
                    const { t: tr } = useTranslations();
                    return <button>{tr('common.cancel')}</button>;
                };
            `,
        });
        const sf = project.getSourceFileOrThrow('/root/AliasedIntl.tsx');
        const result = extractI18nStringsForFile(sf, RU_MESSAGES);
        expect(result).toContain('Отмена');
    });
});

// ---------------------------------------------------------------------------
// P1-B: dynamic key warning fires exactly once per file
// ---------------------------------------------------------------------------
describe('i18n-resolver — dynamic key warning (P1-B)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('emits exactly one WARNING per file for dynamic key arguments', () => {
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

        const project = makeProject({
            '/root/Dynamic.tsx': `
                import { useTranslations } from 'next-intl';
                export const Dynamic = () => {
                    const t = useTranslations();
                    const key = 'foo';
                    return <div>{t(\`common.\${key}\`)}{t(\`buttons.\${key}\`)}</div>;
                };
            `,
        });
        const sf = project.getSourceFileOrThrow('/root/Dynamic.tsx');
        extractI18nStringsForFile(sf, RU_MESSAGES);

        const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
        const dynamicWarns = calls.filter((s) => s.includes('dynamic key argument'));
        // Exactly one warning per file, regardless of how many dynamic keys
        expect(dynamicWarns).toHaveLength(1);
        expect(dynamicWarns[0]).toContain('[arch-graph fe-i18n] WARNING');
    });

    it('emits no warning when all keys are static', () => {
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

        const project = makeProject({
            '/root/Static.tsx': `
                import { useTranslations } from 'next-intl';
                export const Static = () => {
                    const t = useTranslations();
                    return <div>{t('common.apply')}</div>;
                };
            `,
        });
        const sf = project.getSourceFileOrThrow('/root/Static.tsx');
        extractI18nStringsForFile(sf, RU_MESSAGES);

        const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
        const dynamicWarns = calls.filter((s) => s.includes('dynamic key argument'));
        expect(dynamicWarns).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Test 5: object-valued key returns undefined + "key not found" diagnostic
// ---------------------------------------------------------------------------
describe('i18n-resolver — object-valued key (test 5)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('t("common") where common is an object returns nothing and fires "key not found"', () => {
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

        const project = makeProject({
            '/root/ObjKey.tsx': `
                import { useTranslations } from 'next-intl';
                export const ObjKey = () => {
                    const t = useTranslations();
                    return <div>{t('common')}</div>;
                };
            `,
        });
        const sf = project.getSourceFileOrThrow('/root/ObjKey.tsx');
        const result = extractI18nStringsForFile(sf, RU_MESSAGES);

        // Object-valued key should NOT resolve to a string
        expect(result).toEqual([]);

        // "key not found" diagnostic should fire
        const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
        const notFoundWarns = calls.filter((s) => s.includes('key not found'));
        expect(notFoundWarns.length).toBeGreaterThan(0);
        expect(notFoundWarns[0]).toContain('"common"');
    });
});
