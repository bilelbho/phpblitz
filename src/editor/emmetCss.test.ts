import { describe, expect, it } from 'vitest';
import { cssAbbreviationBefore, expandCss, inCssDeclarations } from './emmetCss';

describe('CSS shorthands', () => {
  it('expands numbers with their units', () => {
    expect(expandCss('m10')).toBe('margin: 10px;');
    expect(expandCss('m10-20')).toBe('margin: 10px 20px;');
    expect(expandCss('m10-auto')).toBe('margin: 10px auto;');
    expect(expandCss('m-5')).toBe('margin: -5px;');
    expect(expandCss('p10--5')).toBe('padding: 10px -5px;');
    expect(expandCss('w50p')).toBe('width: 50%;');
    expect(expandCss('fz1.5r')).toBe('font-size: 1.5rem;');
    expect(expandCss('h100vh')).toBe('height: 100vh;');
    expect(expandCss('lh1.4')).toBe('line-height: 1.4;');
    expect(expandCss('z10')).toBe('z-index: 10;');
    expect(expandCss('m0')).toBe('margin: 0;');
    expect(expandCss('bdrs4')).toBe('border-radius: 4px;');
    expect(expandCss('mt10')).toBe('margin-top: 10px;');
  });

  it('expands keywords, colors and !important', () => {
    expect(expandCss('d:f')).toBe('display: flex;');
    expect(expandCss('jc:sb')).toBe('justify-content: space-between;');
    expect(expandCss('pos:a!')).toBe('position: absolute !important;');
    expect(expandCss('d:contents')).toBe('display: contents;');
    expect(expandCss('c#f')).toBe('color: #fff;');
    expect(expandCss('bgc#fc')).toBe('background-color: #fcfcfc;');
    expect(expandCss('c#1e1f22')).toBe('color: #1e1f22;');
    expect(expandCss('m')).toBe('margin: ${1};');
    expect(expandCss('d:')).toBe('display: ${1};');
  });

  it('leaves other words alone', () => {
    expect(expandCss('color')).toBeNull();
    expect(expandCss('foo10')).toBeNull();
    expect(expandCss('xyz:f')).toBeNull();
  });

  it('finds the shorthand and knows where declarations go', () => {
    expect(cssAbbreviationBefore('  m10', 6)).toEqual({ text: 'm10', start: 3 });
    expect(cssAbbreviationBefore('a { d:f', 8)).toEqual({ text: 'd:f', start: 5 });
    const css = '.a { color: red; }\n.b {\n  m10\n}\n/* { */ p';
    expect(inCssDeclarations(css, css.indexOf('m10') + 3)).toBe(true);
    expect(inCssDeclarations(css, css.indexOf('.b'))).toBe(false);
    expect(inCssDeclarations(css, css.length)).toBe(false);
    const scss = "// don't { \n.a {\n  b: url(http://x/y);\n  m";
    expect(inCssDeclarations(scss, scss.length)).toBe(true);
  });
});
