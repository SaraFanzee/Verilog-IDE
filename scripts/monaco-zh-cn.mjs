import { readFile } from 'node:fs/promises';
import ts from 'typescript';

export function monacoChinese() {
  return {
    name: 'monaco-zh-cn',
    setup(build) {
      build.onLoad({ filter: /[\\/]monaco-editor[\\/]esm[\\/]vs[\\/]nls\.js$/ }, async ({ path }) => {
        // Monaco 0.52 ships its Chinese messages in the AMD build. Match them to ESM's English fallbacks.
        const monaco = new URL('../node_modules/monaco-editor/', import.meta.url);
        const [esm, amd, locale] = await Promise.all([
          readFile(path, 'utf8'),
          readFile(new URL('dev/vs/editor/editor.main.js', monaco), 'utf8'),
          readFile(new URL('dev/vs/nls.messages.zh-cn.js', monaco), 'utf8'),
        ]);
        const table = JSON.parse(locale.match(/_VSCODE_NLS_MESSAGES\s*=\s*(\[[^\r\n]*\]);/)?.[1] ?? 'null');
        if (!Array.isArray(table)) throw new Error('Cannot read Monaco’s Simplified Chinese message table.');

        const translations = new Map();
        const source = ts.createSourceFile('editor.main.js', amd, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
        function collect(node) {
          if (ts.isCallExpression(node) && node.arguments.length >= 2) {
            const [index, fallback] = node.arguments;
            if (ts.isNumericLiteral(index) && ts.isStringLiteralLike(fallback)
              && /\.localize2?\)?$/.test(node.expression.getText(source))) {
              const message = table[Number(index.text)];
              if (message && !translations.has(fallback.text)) translations.set(fallback.text, message);
            }
          }
          ts.forEachChild(node, collect);
        }
        collect(source);
        translations.set('Delete Word', '删除单词');
        translations.set('Transform to Kebab Case', '转换为连字符命名');
        const fallback = 'return _format(message, args);';
        const original = 'message = originalMessage;';
        if (!translations.has('Command Palette') || !esm.includes(fallback) || !esm.includes(original)) {
          throw new Error('Monaco’s localization format has changed.');
        }
        const contents = esm
          .replace(fallback, 'return _format(translations.get(message) ?? message, args);')
          .replace(original, 'message = translations.get(originalMessage) ?? originalMessage;');
        return { contents: `const translations = new Map(${JSON.stringify([...translations])});\n${contents}`, loader: 'js' };
      });
      build.onLoad({ filter: /[\\/]monaco-editor[\\/]esm[\\/]vs[\\/]editor[\\/]contrib[\\/]inlineEdit[\\/]browser[\\/]commands\.js$/ }, async ({ path }) => {
        // This command's display label is hard-coded in Monaco 0.52.
        const source = await readFile(path, 'utf8');
        return { contents: source.replace("label: 'Trigger Inline Edit'", "label: '触发内联编辑'"), loader: 'js' };
      });
    },
  };
}
