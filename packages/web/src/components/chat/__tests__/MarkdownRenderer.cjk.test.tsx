import { cleanup, render, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import MarkdownRenderer from '../MarkdownRenderer';

afterEach(cleanup);

for (const artifactLinks of [false, true]) {
  describe(`MarkdownRenderer CJK emphasis (${artifactLinks ? 'preview' : 'chat'})`, () => {
    const fixtures = [
      ['共可达**$38.43/月**，', '<p>共可达<strong>$38.43/月</strong>，</p>'],
      [
        '共可达**$38.43/月**，普通文字和**下一项**。',
        '<p>共可达<strong>$38.43/月</strong>，普通文字和<strong>下一项</strong>。</p>',
      ],
      ['中文**「重点」**后文', '<p>中文<strong>「重点」</strong>后文</p>'],
      ['日本語*「強調」*です。', '<p>日本語<em>「強調」</em>です。</p>'],
      ['한글**（강조）**입니다。', '<p>한글<strong>（강조）</strong>입니다。</p>'],
      ['前文***「重点」***后文', '<p>前文<em><strong>「重点」</strong></em>后文</p>'],
      [
        '**bold** and *italic* foo_bar_baz foo**bar**baz',
        '<p><strong>bold</strong> and <em>italic</em> foo_bar_baz foo<strong>bar</strong>baz</p>',
      ],
      ['a**$3**b', '<p>a**$3**b</p>'],
      ['`共可达**$38.43/月**，`', '<p><code>共可达**$38.43/月**，</code></p>'],
      ['\\*\\*价格\\*\\* $38.43 and $50', '<p>**价格** $38.43 and $50</p>'],
      [
        '[**链接**](#price)\n下一行',
        '<p><a href="#price"><strong>链接</strong></a><br>\n下一行</p>',
      ],
      ['~~old~~', '<p><del>old</del></p>'],
    ];
    it.each(fixtures)('renders %s', async (content, html) => {
      const view = render(<MarkdownRenderer content={content} artifactLinks={artifactLinks} />);
      await waitFor(() =>
        expect(view.container.querySelector('.prose')?.innerHTML).toContain('<p')
      );
      const prose = view.container.querySelector('.prose')!.cloneNode(true) as HTMLElement;
      prose.querySelectorAll('[style]').forEach((node) => node.removeAttribute('style'));
      expect(prose.innerHTML).toBe(html);
    });
    it('preserves tables, fenced code and double-dollar math', async () => {
      const view = render(
        <MarkdownRenderer
          artifactLinks={artifactLinks}
          content={'| Price |\n| --- |\n| **$38.43/月** |\n\n```text\n**原样**\n```\n\n$$x^2$$'}
        />
      );
      await waitFor(() => expect(view.container.querySelector('.katex')).toBeTruthy());
      expect(view.container.querySelector('td strong')?.textContent).toBe('$38.43/月');
      expect(view.container.querySelector('pre code')?.textContent).toBe('**原样**\n');
    });
  });
}
