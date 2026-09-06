/**
 * src/shared/names.ts — the display-name blocklist behind 400 'bad-name'.
 * Korean and English terms, disguises (spacing, case, leet, repeats), and the
 * ordinary names that must never be caught.
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_BLOCKLIST, EXTRA_BLOCKLIST, badNameMatch, collapseRuns, isBadName, nameVariants, normalizeName, parseBlocklist,
} from '../../src/shared/names.js';

describe('names blocklist', () => {
  it('ships a built-in Korean + English list and an (initially empty) operator file', () => {
    expect(BUILTIN_BLOCKLIST.length).toBeGreaterThan(50);
    expect(BUILTIN_BLOCKLIST).toContain('씨발');
    expect(BUILTIN_BLOCKLIST).toContain('병신');
    expect(BUILTIN_BLOCKLIST).toContain('fuck');
    expect(BUILTIN_BLOCKLIST).toContain('nigger');
    expect(Array.isArray(EXTRA_BLOCKLIST)).toBe(true);
  });

  it('catches Korean profanity and slurs, whole or inside a name', () => {
    for (const name of ['씨발', '시발놈', '병신아', '븅신', '개새끼', '느금마', '짱깨', '쪽바리', '좆같네', '지랄맨', 'ㅅㅂ', 'ㅂㅅ', '존나빠름']) {
      expect(isBadName(name), name).toBe(true);
    }
  });

  it('catches English profanity and slurs, case-insensitively', () => {
    for (const name of ['fuck', 'FUCK', 'Shithead', 'BitchBoy', 'nigger', 'NIGGA', 'faggot', 'Retard', 'xXcuntXx', 'asshole']) {
      expect(isBadName(name), name).toBe(true);
    }
  });

  it('sees through spacing, punctuation, leet and repeated letters', () => {
    for (const name of ['s h i t', 'f.u.c.k', 'sh!t', '5hit', 'b1tch', 'fvck', 'fuuuuck', 'n1gg3r', '씨 발', '시1발', '병_신', '씨.발']) {
      expect(isBadName(name), name).toBe(true);
    }
  });

  it('leaves ordinary Korean and English names alone', () => {
    for (const name of [
      '클로드', '빠름', '더빠름', '피해자', '침수', '개발자', '주자', '늦음', '다른이', '사람', '가', '나',
      '시바견', '미니미', '무지개새', '잠자리', '보물', '자전거', '개구리', '조수웅덩이', '메아리',
      'peacock', 'Dickens', 'classic', 'Sussex', 'grape', 'analyst', 'canal', 'Japan', 'spicy', 'raccoon',
      'tycoon', 'therapist', 'homophone', 'assassin', 'Kyson', 'torpedo', 'niga', 'Clawd', 'Player One',
    ]) {
      expect(badNameMatch(name), name).toBeNull();
    }
  });

  it('badNameMatch names the term that matched', () => {
    expect(badNameMatch('xx씨발xx')).toBe('씨발');
    expect(badNameMatch('sh!t')).toBe('shit');
    expect(badNameMatch('클로드')).toBeNull();
  });

  it('extra terms extend the built-in list without replacing it', () => {
    expect(isBadName('zorblax')).toBe(false);
    expect(isBadName('zorblax', ['zorblax'])).toBe(true);
    expect(isBadName('Zor blax!', ['zorblax'])).toBe(true);
    expect(isBadName('씨발', ['zorblax'])).toBe(true);
    // an extra term with spaces / case is normalised like a name
    expect(isBadName('badword', ['Bad Word'])).toBe(true);
  });

  it('normalizeName / nameVariants / collapseRuns', () => {
    expect(normalizeName('  Ｆｕｃｋ  ')).toBe('fuck'); // NFKC folds fullwidth
    expect(nameVariants('sh!t 1')).toEqual(['sh!t1', 'sht', 'shiti']);
    expect(nameVariants('')).toEqual([]);
    expect(collapseRuns('fuuuck')).toBe('fuck');
    expect(collapseRuns('aabbcc')).toBe('abc');
  });

  it('parseBlocklist reads the JSON file format and plain lines, ignoring junk', () => {
    expect(parseBlocklist('{ "words": ["a", "b c", "", 3] }')).toEqual(['a', 'b c']);
    expect(parseBlocklist('["x", "y"]')).toEqual(['x', 'y']);
    expect(parseBlocklist('# comment\nfoo\n\nbar\n')).toEqual(['foo', 'bar']);
    expect(parseBlocklist('')).toEqual([]);
    expect(parseBlocklist('{ not json')).toEqual([]);
    expect(parseBlocklist('{ "nope": 1 }')).toEqual([]);
  });
});
