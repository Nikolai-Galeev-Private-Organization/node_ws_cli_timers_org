module.exports = {
  async up(db) {
    // Создаем коллекцию пользователей
    await db.createCollection("timer_users");
    // Создаем уникальный индекс для username, чтобы избежать дублирования
    await db.collection("timer_users").createIndex({ username: 1 }, { unique: true });

    // Создаем коллекцию сессий
    await db.createCollection("timer_sessions");
    // Индекс для быстрого поиска сессии
    await db.collection("timer_sessions").createIndex({ sessionId: 1 }, { unique: true });
    await db.collection("timer_sessions").createIndex({ userId: 1 }, { unique: true });

    // Создаем коллекцию таймеров
    await db.createCollection("timers");
    // Индекс для поиска таймеров по пользователю и статусу
    await db.collection("timers").createIndex({ userId: 1, isActive: 1 });
  },

  async down(db) {
    // Откат миграции: удаляем коллекции
    await db
      .collection("timers")
      .drop()
      .catch(() => {});
    await db
      .collection("timer_sessions")
      .drop()
      .catch(() => {});
    await db
      .collection("timer_users")
      .drop()
      .catch(() => {});
  },
};
