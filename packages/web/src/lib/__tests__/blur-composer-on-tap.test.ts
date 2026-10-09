import { afterEach, describe, expect, it } from 'vitest';
import { blurComposerOnTap } from '../blur-composer-on-tap.ts';

function setup(transcript: string) {
  document.body.innerHTML = `<div id="area">${transcript}</div><textarea id="composer"></textarea>`;
  const area = document.getElementById('area') as HTMLDivElement;
  const composer = document.getElementById('composer') as HTMLTextAreaElement;
  area.addEventListener('click', blurComposerOnTap);
  composer.focus();
  return { area, composer };
}

describe('blurComposerOnTap', () => {
  afterEach(() => {
    document.getSelection()?.removeAllRanges();
    document.body.innerHTML = '';
  });

  it('blurs a focused composer when plain transcript text is tapped', () => {
    const { area, composer } = setup('<p id="text">hello</p>');
    expect(document.activeElement).toBe(composer);
    (area.querySelector('#text') as HTMLElement).click();
    expect(document.activeElement).not.toBe(composer);
  });

  it('keeps focus when a link, button, or summary in a message is tapped', () => {
    const { area, composer } = setup(
      '<a id="link" href="#x"><span id="inner">go</span></a><button id="copy">copy</button><details><summary id="sum">more</summary></details>'
    );
    for (const id of ['inner', 'copy', 'sum']) {
      (area.querySelector(`#${id}`) as HTMLElement).click();
      expect(document.activeElement).toBe(composer);
    }
  });

  it('keeps focus while text in the transcript is selected', () => {
    const { area, composer } = setup('<p id="text">select me</p>');
    const text = area.querySelector('#text') as HTMLElement;
    document.getSelection()?.selectAllChildren(text);
    text.click();
    expect(document.activeElement).toBe(composer);
  });

  it('leaves a textarea inside the transcript alone', () => {
    const { area } = setup('<textarea id="edit"></textarea><p id="text">hi</p>');
    const edit = area.querySelector('#edit') as HTMLTextAreaElement;
    edit.focus();
    (area.querySelector('#text') as HTMLElement).click();
    expect(document.activeElement).toBe(edit);
  });
});
