import { describe, expect, it } from 'vitest';
import { abbreviationBefore, expandAbbreviation, isAbbreviation } from './emmet';

const x = (a: string) => expandAbbreviation(a, '  ');

describe('expandAbbreviation', () => {
  it('writes elements with classes, ids, attributes and text', () => {
    expect(x('div.card#main')).toBe('<div id="main" class="card">${1}</div>');
    expect(x('p{Hello}')).toBe('<p>Hello</p>');
    expect(x('a')).toBe('<a href="${1}">${2}</a>');
    expect(x('input[type=email name="user mail" required]')).toBe('<input type="email" name="user mail" required>');
    expect(x('img')).toBe('<img src="${1}" alt="${2}">');
    expect(x('.box')).toBe('<div class="box">${1}</div>');
  });

  it('nests, repeats and numbers', () => {
    expect(x('ul>li.item-$*3')).toBe(['<ul>', '  <li class="item-1">${1}</li>', '  <li class="item-2">${2}</li>', '  <li class="item-3">${3}</li>', '</ul>'].join('\n'));
    expect(x('ul>.x*2')).toBe(['<ul>', '  <li class="x">${1}</li>', '  <li class="x">${2}</li>', '</ul>'].join('\n'));
    expect(x('li*2>a{Item $$}')).toBe(['<li><a href="${1}">Item 01</a></li>', '<li><a href="${2}">Item 02</a></li>'].join('\n'));
    expect(x('p>span')).toBe('<p><span>${1}</span></p>');
  });

  it('climbs with ^ and groups with ()', () => {
    expect(x('div>p^footer')).toBe(['<div>', '  <p>${1}</p>', '</div>', '<footer>${2}</footer>'].join('\n'));
    expect(x('(dt+dd)*2')).toBe(['<dt>${1}</dt>', '<dd>${2}</dd>', '<dt>${3}</dt>', '<dd>${4}</dd>'].join('\n'));
    expect(x('table>tr>td*2')).toBe(['<table>', '  <tr>', '    <td>${1}</td>', '    <td>${2}</td>', '  </tr>', '</table>'].join('\n'));
  });

  it('escapes snippet characters and refuses what is not an abbreviation', () => {
    expect(x('p{costs $5}')).toBe('<p>costs \\$5</p>');
    expect(x('hello')).toBeNull();
    expect(x('div>')).toBeNull();
    expect(x('(div')).toBeNull();
    expect(x('!')).toContain('<!DOCTYPE html>');
  });
});

describe('abbreviationBefore', () => {
  it('finds the abbreviation before the caret', () => {
    expect(abbreviationBefore('    ul>li*2', 12)).toEqual({ text: 'ul>li*2', start: 5 });
    expect(abbreviationBefore('<p>a{Go home}', 14)).toEqual({ text: 'a{Go home}', start: 4 });
    expect(abbreviationBefore('<div class="x">span.y', 22)).toEqual({ text: 'span.y', start: 16 });
  });
  it('leaves text, words and tags alone', () => {
    expect(abbreviationBefore('Some words here', 16)).toBeNull();
    expect(abbreviationBefore('<div cla', 9)).toBeNull();
    expect(isAbbreviation('3.5')).toBe(false);
  });
});
