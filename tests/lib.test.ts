import { describe, expect, it } from 'vitest';
import { type Hours, addBusinessMinutes, businessMinutesBetween, isOpen, nextOpen, zonedToUtc } from '../src/lib/calendar.js';
import { formatParticipantCode, isValidPhoneCheckinId, newParticipantCode, newPhoneCheckinId, parseParticipantCode, CODE_ALPHABET } from '../src/lib/codes.js';
import { aesDecrypt, aesEncrypt, normalizeAnswer, totpAt, verifyTotp, base32Encode } from '../src/lib/crypto.js';

const H: Hours = { tz: 'America/New_York', startMin: 480, endMin: 1020, days: [1, 2, 3, 4, 5], holidays: new Set(['2026-11-26']) };

describe('business calendar', () => {
  it('converts local wall time across daylight-saving changes', () => {
    expect(new Date(zonedToUtc(2026, 3, 9, 480, 'America/New_York')).toISOString()).toBe('2026-03-09T12:00:00.000Z'); // EDT
    expect(new Date(zonedToUtc(2026, 3, 6, 480, 'America/New_York')).toISOString()).toBe('2026-03-06T13:00:00.000Z'); // EST
    expect(new Date(zonedToUtc(2026, 11, 2, 480, 'America/New_York')).toISOString()).toBe('2026-11-02T13:00:00.000Z');
  });

  it('knows staffed hours, weekends and holidays', () => {
    expect(isOpen(Date.parse('2026-11-16T14:00:00Z'), H)).toBe(true); // Mon 09:00
    expect(isOpen(Date.parse('2026-11-16T23:00:00Z'), H)).toBe(false); // Mon 18:00
    expect(isOpen(Date.parse('2026-11-21T15:00:00Z'), H)).toBe(false); // Saturday
    expect(isOpen(Date.parse('2026-11-26T15:00:00Z'), H)).toBe(false); // Thanksgiving (holiday)
    expect(new Date(nextOpen(Date.parse('2026-11-25T23:00:00Z'), H)).toISOString()).toBe('2026-11-27T13:00:00.000Z');
  });

  it('adds business minutes over nights, weekends and holidays', () => {
    // Friday 15:00 + 3h → Monday 09:00
    expect(new Date(addBusinessMinutes(Date.parse('2026-11-20T20:00:00Z'), 180, H)).toISOString()).toBe('2026-11-23T14:00:00.000Z');
    // Wednesday 16:00 before Thanksgiving + 2h → Friday 09:00
    expect(new Date(addBusinessMinutes(Date.parse('2026-11-25T21:00:00Z'), 120, H)).toISOString()).toBe('2026-11-27T14:00:00.000Z');
    // across the March DST change: Friday 16:00 EST + 2h → Monday 09:00 EDT
    expect(new Date(addBusinessMinutes(Date.parse('2026-03-06T21:00:00Z'), 120, H)).toISOString()).toBe('2026-03-09T13:00:00.000Z');
    expect(businessMinutesBetween(Date.parse('2026-11-20T20:00:00Z'), Date.parse('2026-11-23T14:00:00Z'), H)).toBe(180);
  });
});

describe('participant codes', () => {
  it('round-trips and catches every single-character typo and adjacent swap', () => {
    for (let n = 0; n < 50; n++) {
      const code = newParticipantCode();
      expect(parseParticipantCode(formatParticipantCode(code))).toBe(code);
      expect(parseParticipantCode(code.toLowerCase())).toBe(code);
      for (let i = 0; i < code.length; i++) {
        for (const ch of CODE_ALPHABET) {
          if (ch === code[i]) continue;
          const bad = code.slice(0, i) + ch + code.slice(i + 1);
          expect(parseParticipantCode(bad)).toBeNull();
        }
        if (i < code.length - 1 && code[i] !== code[i + 1]) {
          const swapped = code.slice(0, i) + code[i + 1] + code[i] + code.slice(i + 2);
          expect(parseParticipantCode(swapped)).toBeNull();
        }
      }
    }
  });

  it('keypad check-in numbers have a valid check digit', () => {
    for (let n = 0; n < 50; n++) {
      const id = newPhoneCheckinId();
      expect(isValidPhoneCheckinId(id)).toBe(true);
      const bad = id.slice(0, 7) + String((Number(id[7]) + 1) % 10);
      expect(isValidPhoneCheckinId(bad)).toBe(false);
    }
  });
});

describe('crypto', () => {
  it('authenticated encryption binds ciphertext to its field', () => {
    const key = Buffer.alloc(32, 7);
    const blob = aesEncrypt(key, Buffer.from('Laura'), 'p1:name');
    expect(aesDecrypt(key, blob, 'p1:name').toString()).toBe('Laura');
    expect(() => aesDecrypt(key, blob, 'p2:name')).toThrow();
  });

  it('TOTP matches the RFC 6238 test vector and tolerates one step of drift', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(totpAt(secret, 59_000)).toBe('287082');
    expect(verifyTotp(secret, '287082', 59_000 + 30_000)).toBe(true);
    expect(verifyTotp(secret, '287082', 59_000 + 90_000)).toBe(false);
  });

  it('normalizes verification answers', () => {
    expect(normalizeAnswer('  Blue  River! ')).toBe(normalizeAnswer('blueriver'));
    expect(normalizeAnswer('Café')).toBe('cafe');
  });
});
