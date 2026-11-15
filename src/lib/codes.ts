import { randomBytes } from 'node:crypto';

/**
 * Participant codes: 8 random characters from a 31-character alphabet without look-alikes
 * (no 0/O, 1/I/L), plus a check character, printed as HB-XXXX-XXXX-C. They carry no meaning.
 * The check is a position-weighted sum mod 31; because 31 is prime it catches every
 * single-character typo and every swap of two adjacent characters.
 */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const N = CODE_ALPHABET.length;

function luhnCheck(chars: string): string {
  let sum = 0;
  for (let i = 0; i < chars.length; i++) sum += (i + 1) * CODE_ALPHABET.indexOf(chars[i]!);
  return CODE_ALPHABET[sum % N]!;
}

export function newParticipantCode(): string {
  const bytes = randomBytes(8);
  let body = '';
  for (let i = 0; i < 8; i++) body += CODE_ALPHABET[bytes[i]! % N];
  return body + luhnCheck(body);
}

/** Canonical 9-character form, or null if the input cannot be a valid code. */
export function parseParticipantCode(input: string): string | null {
  let s = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.startsWith('HB') && s.length === 11) s = s.slice(2);
  if (s.length !== 9 || [...s].some((c) => !CODE_ALPHABET.includes(c))) return null;
  return luhnCheck(s.slice(0, 8)) === s[8] ? s : null;
}

export function formatParticipantCode(code: string): string {
  return `HB-${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}

/** 8-digit phone check-in number (7 random digits + Luhn check digit) for keypad check-ins. */
export function newPhoneCheckinId(): string {
  const bytes = randomBytes(7);
  let body = String(1 + (bytes[0]! % 9));
  for (let i = 1; i < 7; i++) body += String(bytes[i]! % 10);
  return body + luhnDigit(body);
}

function luhnDigit(digits: string): string {
  let sum = 0;
  let dbl = true;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return String((10 - (sum % 10)) % 10);
}

export function isValidPhoneCheckinId(s: string): boolean {
  return /^\d{8}$/.test(s) && luhnDigit(s.slice(0, 7)) === s[7];
}

/** Normalizes a US phone number to E.164, or returns null. */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (input.trim().startsWith('+') && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}
