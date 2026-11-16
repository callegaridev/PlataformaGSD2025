class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

function text(value, field, maxLength = 5000, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return null;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new ValidationError(`${field} inválido.`);
  }
  return value.trim();
}

function integer(value, field, minimum = 1) {
  if (!(typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value)))) {
    throw new ValidationError(`${field} inválido.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new ValidationError(`${field} inválido.`);
  }
  return parsed;
}

function money(value, field, minimum = 0) {
  if (!(typeof value === 'number' || typeof value === 'string')) {
    throw new ValidationError(`${field} inválido.`);
  }
  const raw = String(value);
  const parsed = Number(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw) || !Number.isFinite(parsed) || parsed < minimum) {
    throw new ValidationError(`${field} inválido.`);
  }
  return parsed.toFixed(2);
}

function secret(value, field, maxLength = 128) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new ValidationError(`${field} inválida.`);
  }
  return value;
}

function date(value, field, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new ValidationError(`${field} inválido.`);
  return parsed.toISOString();
}

function email(value) {
  const normalized = text(value, 'E-mail', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new ValidationError('E-mail inválido.');
  }
  return normalized;
}

module.exports = { ValidationError, date, email, integer, money, secret, text };
