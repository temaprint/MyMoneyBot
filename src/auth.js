// Авторизация дашборда через бота (Поток 2 из auth.md):
// бот получает одноразовый LoginToken -> кнопка в браузер -> сессия в cookie.
import { createHash, randomBytes } from 'node:crypto';
import { prisma } from './db.js';
import { LOGIN_TOKEN_TTL_MIN, ADMIN_USERNAMES } from './config.js';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

// telegramUser: { id, username, first_name, last_name, photo_url }
export async function createLoginToken(telegramUser) {
  await prisma.loginToken.deleteMany({ where: { expiresAt: { lt: new Date() } } }); // ленивая чистка

  const token = 'llt_' + randomBytes(24).toString('hex');
  await prisma.loginToken.create({
    data: {
      tokenHash: sha256(token),
      telegramId: String(telegramUser.id),
      username: telegramUser.username ?? null,
      firstName: telegramUser.first_name ?? null,
      lastName: telegramUser.last_name ?? null,
      photoUrl: telegramUser.photo_url ?? null,
      expiresAt: new Date(Date.now() + LOGIN_TOKEN_TTL_MIN * 60 * 1000),
    },
  });
  return token;
}

// Возвращает запись токена или null (нет / использован / истёк). Помечает использованным.
export async function consumeLoginToken(token) {
  const record = await prisma.loginToken.findUnique({ where: { tokenHash: sha256(token) } });
  if (!record || record.usedAt || record.expiresAt < new Date()) return null;
  await prisma.loginToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });
  return record;
}

export async function upsertUserFromTelegram(record) {
  const isAdmin = ADMIN_USERNAMES.includes((record.username ?? '').toLowerCase());
  const data = {
    username: record.username,
    firstName: record.firstName,
    lastName: record.lastName,
    photoUrl: record.photoUrl,
  };
  return prisma.user.upsert({
    where: { telegramId: record.telegramId },
    create: { telegramId: record.telegramId, isAdmin, ...data },
    update: isAdmin ? { ...data, isAdmin: true } : data,
  });
}

export async function createSession(userId, ttlDays) {
  const token = randomBytes(32).toString('hex');
  await prisma.session.create({
    data: {
      userId,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000),
    },
  });
  return token;
}

// Cookie-токен -> User | null (истёкшие сессии удаляются на месте)
export async function getSessionUser(token) {
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: true },
  });
  if (!session) return null;
  if (session.expiresAt < new Date()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  return session.user;
}

export async function deleteSession(token) {
  if (!token) return;
  await prisma.session.deleteMany({ where: { tokenHash: sha256(token) } });
}
