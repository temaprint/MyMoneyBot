// Подписки чатов на ежедневный автопост (таблица ChatSubscription)
import { prisma } from './db.js';

export async function loadChatIds() {
  const rows = await prisma.chatSubscription.findMany();
  return rows.map((row) => row.chatId);
}

export async function subscribe(chatId) {
  const id = String(chatId);
  const existing = await prisma.chatSubscription.findUnique({ where: { chatId: id } });
  if (existing) return false;
  await prisma.chatSubscription.create({ data: { chatId: id } });
  return true;
}

export async function unsubscribe(chatId) {
  const result = await prisma.chatSubscription.deleteMany({ where: { chatId: String(chatId) } });
  return result.count > 0;
}
