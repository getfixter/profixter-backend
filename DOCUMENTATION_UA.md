# 📚 Документація Backend - Проект Handyman (Mr. Fixter / Profixter)

## 📋 Зміст
1. [Загальний огляд](#загальний-огляд)
2. [Архітектура проекту](#архітектура-проекту)
3. [Технологічний стек](#технологічний-стек)
4. [Структура файлів](#структура-файлів)
5. [Моделі даних](#моделі-даних)
6. [API маршрути](#api-маршрути)
7. [Middleware](#middleware)
8. [Утиліти](#утиліти)
9. [Автоматизація (CRON)](#автоматизація-cron)
10. [Інтеграції](#інтеграції)
11. [Налаштування та змінні оточення](#налаштування-та-змінні-оточення)

---

## 🎯 Загальний огляд

Це backend додаток для сервісу **Mr. Fixter (Profixter)** - платформи для необмеженого доступу до послуг майстрів на Long Island, NY (округи Nassau та Suffolk).

### Основні функції:
- ✅ Реєстрація та аутентифікація користувачів
- � Відновлення пароля через OTP код (6-значний, 5 хвилин)
- �📅 Система бронювання з календарем та управлінням слотами
- 💳 Інтеграція зі Stripe для підписок та платежів
- 🤖 AI чатбот (OpenAI GPT-4) для консультацій
- 📧 Email сервіс (AWS SES) для транзакційних листів
- 👥 Система рефералів
- 📊 Адмін панель для управління
- 🔄 Автоматичні нагадування та follow-up emails
- 🌍 Підтримка множинних адрес для користувачів

---

## 🏗 Архітектура проекту

### Тип: Монолітний REST API сервер
- **Framework**: Express.js (Node.js)
- **База даних**: MongoDB (через Mongoose ODM)
- **Hosting**: AWS Elastic Beanstalk (згідно з Procfile)
- **Storage**: AWS S3 для файлів (зображення до бронювань)

### Ключові патерни:
- MVC (Model-View-Controller) архітектура
- Middleware для аутентифікації та валідації
- RESTful API endpoints
- JWT токени для авторизації
- Webhook-based інтеграції (Stripe)

---

## 🛠 Технологічний стек

### Основні залежності:
```json
{
  "express": "^4.18.2",           // Web фреймворк
  "mongoose": "^7.8.6",           // MongoDB ODM
  "bcryptjs": "^3.0.2",           // Хешування паролів
  "jsonwebtoken": "^9.0.2",       // JWT аутентифікація
  "stripe": "^17.7.0",            // Платіжна система
  "nodemailer": "^6.10.1",        // Email відправка
  "@aws-sdk/client-s3": "^3.876", // AWS S3 для файлів
  "multer": "^1.4.5-lts.2",       // Завантаження файлів
  "node-cron": "^4.2.1",          // CRON задачі
  "moment-timezone": "^0.6.0",    // Робота з часовими зонами
  "cors": "^2.8.5",               // CORS middleware
  "dotenv": "^16.4.7"             // Змінні оточення
}
```

### Node.js версія: 18.x

---

## 📁 Структура файлів

```
backend/
├── server.js                 # Головний файл сервера
├── package.json             # Залежності проекту
├── Procfile                 # Конфігурація для Heroku/AWS EB
│
├── models/                  # Mongoose схеми та моделі
│   ├── User.js             # Користувач
│   ├── Booking.js          # Бронювання
│   ├── Subscription.js     # Підписки
│   ├── Lead.js             # Ліди (потенційні клієнти)
│   ├── Conversation.js     # Історія чату
│   ├── Referral.js         # Реферальні запрошення
│   ├── CalendarConfig.js   # Налаштування календаря
│   ├── SlotCounter.js      # Лічильник доступних слотів
│   ├── Otp.js              # OTP коди
│   ├── Blacklist.js        # Чорний список
│   └── Request.js          # Запити клієнтів
│
├── routes/                 # API маршрути (endpoints)
│   ├── auth.js            # Авторизація та реєстрація
│   ├── users.js           # Управління користувачами
│   ├── bookings.js        # CRUD для бронювань
│   ├── subscriptions.js   # Підписки користувачів
│   ├── stripe.js          # Stripe checkout сесії
│   ├── webhook.js         # Stripe webhooks
│   ├── chatbot.js         # AI чатбот
│   ├── calendar.js        # Календар та слоти
│   ├── adminCalendar.js   # Адмін управління календарем
│   ├── admin.js           # Адмін панель
│   ├── referrals.js       # Система рефералів
│   ├── feedback.js        # Відгуки клієнтів
│   ├── facebook.js        # Facebook інтеграції
│   ├── track.js           # Трекінг подій
│   ├── passwordReset.js   # Скидання пароля
│   ├── requests.js        # Запити на послуги
│   └── test.js            # Тестові endpoints
│
├── middleware/            # Middleware функції
│   ├── auth.js           # JWT перевірка
│   ├── blacklist.js      # Перевірка чорного списку
│   └── otpRateLimit.js   # Rate limiting для OTP
│
├── controllers/          # Контролери бізнес-логіки
│   └── facebookCapi.js  # Facebook Conversion API
│
├── utils/               # Утилітні функції
│   ├── emailService.js  # Відправка email через AWS SES
│   ├── s3.js           # Робота з AWS S3
│   └── getNextAvailableSlot.js  # Логіка вільних слотів
│
├── data/               # Статичні дані
│   └── chatbotKnowledge.js  # База знань для чатбота
│
├── scripts/           # Міграційні скрипти
│   ├── migrate_addresses.js
│   ├── backfill_subscription_address.js
│   ├── ensure_primary_and_link_subs.js
│   └── migrate_legacy_subs_to_address.js
│
├── nudge_lead_v1.json  # Email шаблон (follow-up 1)
└── nudge_lead_v2.json  # Email шаблон (follow-up 2)
```

---

## 🗃 Моделі даних

### 1. **User** (`models/User.js`)
Головна модель користувача системи.

**Поля:**
- `userId` (String, unique) - 8-значний публічний ID
- `name` (String) - Ім'я користувача
- `email` (String, unique, lowercase) - Email
- `password` (String) - Хешований пароль (bcrypt)
- `phone` (String) - Номер телефону
- `stripeCustomerId` (String) - ID клієнта в Stripe

**Адреси (множинні):**
- `addresses` (Array) - Масив адрес користувача
  - `label` - Назва (напр. "Primary", "Summer House")
  - `line1` - Адреса
  - `city` - Місто
  - `state` - Штат (за замовчуванням "NY")
  - `zip` - Поштовий індекс
  - `county` - Округ (Nassau або Suffolk)
- `defaultAddressId` (ObjectId) - ID адреси за замовчуванням

**Legacy поля (сумісність):**
- `address`, `city`, `state`, `zip`, `county` - Старий формат адреси
- `subscription` (String) - Тип підписки (basic/plus/premium/elite)
- `subscriptionExpiry` (Date) - Дата закінчення підписки
- `subscriptionStart` (Date) - Дата початку підписки

---

### 2. **Booking** (`models/Booking.js`)
Бронювання послуг майстра.

**Поля:**
- `bookingNumber` (String) - Номер бронювання
- `date` (Date) - Дата і час візиту
- `service` (String) - Опис послуги
- `user` (ObjectId ref User) - Посилання на користувача
- `userId` (String) - Публічний ID користувача
- `addressId` (ObjectId) - ID адреси для візиту
- `address`, `city`, `state`, `zip`, `county` - Деталі адреси
- `phone`, `email`, `name` - Контактна інформація
- `subscription` (String) - Тип підписки на момент створення
- `note` (String) - Примітки до бронювання
- `images` (Array) - URLs зображень проблеми
- `status` (String) - Статус: Pending/Confirmed/Completed/Canceled
- `statusHistory` (Array) - Історія зміни статусів
- `cancellationReason` (String) - Причина скасування
- `feedback` (String) - Відгук після виконання
- `assignedHandyman` (String) - Призначений майстер

**Індекси:** За user, addressId, date, status для швидкого пошуку.

---

### 3. **Subscription** (`models/Subscription.js`)
Підписки користувачів (нова модель для множинних адрес).

**Поля:**
- `user` (ObjectId ref User) - Користувач
- `addressId` (ObjectId) - Адреса, на яку оформлена підписка
- `subscriptionType` (String) - Тип: basic/plus/premium/elite
- `status` (String) - active/canceled/past_due/trialing
- `stripeSubscriptionId` (String) - ID підписки в Stripe
- `stripePriceId` (String) - ID ціни в Stripe
- `startDate` (Date) - Дата початку
- `nextPaymentDate` (Date) - Наступний платіж
- `latestPaymentDate` (Date) - Останній платіж
- `planPrice` (Number) - Ціна плану

---

### 4. **Lead** (`models/Lead.js`)
Потенційні клієнти (ліди) з чатбота або форм.

**Поля:**
- `name`, `email`, `phone` - Контактні дані
- `address_line1`, `city`, `state`, `zip`, `county` - Адреса
- `channel` (String) - Канал: web/messenger/sms
- `source` (String) - Джерело: landing page, ad, тощо
- `status` (String enum) - new/engaged/converted/out_of_area/waitlist
- `lastContactAt` (Date) - Останній контакт
- `followup1SentAt` (Date) - Перший follow-up (~2 години)
- `followup2SentAt` (Date) - Другий follow-up (~48 годин)
- `convertedAt` (Date) - Коли конвертувався в клієнта
- `tags` (Array) - Теги для сегментації
- `notes` (String) - Примітки

---

### 5. **Conversation** (`models/Conversation.js`)
Історія розмов з чатботом.

**Поля:**
- `sessionId` (String) - ID сесії чату
- `messages` (Array) - Масив повідомлень {role, content, timestamp}
- `lead` (ObjectId ref Lead) - Пов'язаний лід

---

### 6. **CalendarConfig** (`models/CalendarConfig.js`)
Конфігурація календаря для бронювань.

**Поля:**
- `date` (String, YYYY-MM-DD) - Дата
- `totalCapacity` (Number) - Загальна кількість слотів на день
- `disabled` (Boolean) - Чи вимкнений цей день

---

### 7. **SlotCounter** (`models/SlotCounter.js`)
Лічильник використаних слотів на день.

**Поля:**
- `date` (String, YYYY-MM-DD, unique) - Дата
- `count` (Number) - Кількість зайнятих слотів

---

### 8. **Referral** (`models/Referral.js`)
Реферальна система.

**Поля:**
- `referrer` (ObjectId ref User) - Хто запросив
- `referredEmail` (String) - Email запрошеного
- `status` (String) - pending/converted
- `code` (String) - Реферальний код

---

### 9. **Blacklist** (`models/Blacklist.js`)
Чорний список користувачів.

**Поля:**
- `userId` (ObjectId ref User)
- `reason` (String) - Причина блокування
- `addedAt` (Date)

---

### 10. **Otp** (`models/Otp.js`)
OTP коди для відновлення пароля.

**Поля:**
- `email` (String, indexed, lowercase) - Email користувача
- `hash` (String) - Bcrypt hash 6-значного OTP коду
- `createdAt` (Date, TTL index) - Автоматично видаляється через 5 хвилин (300 секунд)

**Безпека:**
- Зберігається тільки hash, не сам код
- Автоматичне видалення через MongoDB TTL index
- Одноразове використання (видаляється після verify)
- Rate limiting на рівні роута

---

## 🌐 API маршрути

### 🔐 Аутентифікація (`/api/auth`)

#### POST `/api/auth/register`
Реєстрація нового користувача.
- **Body**: `{ name, email, password, phone, address, city, state, zip, county }`
- **Response**: `{ token, user }`

#### POST `/api/auth/login`
Вхід в систему.
- **Body**: `{ email, password }`
- **Response**: `{ token, user }`

#### GET `/api/auth/me`
Отримати дані поточного користувача.
- **Headers**: `Authorization: Bearer <token>`
- **Response**: `{ user, coverage }` - дані користувача + покриття підписок по адресам

---

### � Відновлення пароля (`/api/password-reset`)

Система відновлення пароля через OTP код (3-етапний процес).

#### POST `/api/password-reset`
**Крок 1:** Запросити OTP код на email.
- **Body**: `{ email }`
- **Response**: `{ message: "OTP sent" }`
- **Дія**: 
  - Генерує 6-значний OTP код
  - Видаляє старі коди для цього email
  - Зберігає bcrypt hash коду в БД (TTL 5 хвилин)
  - Відправляє код на email через шаблон `password_otp`
- **Rate Limiting**: 3 запити на хвилину на IP+email

#### POST `/api/password-reset/verify`
**Крок 2:** Перевірити OTP код та отримати reset token.
- **Body**: `{ email, otp }`
- **Response**: `{ message: "OTP verified", token: "<resetToken>" }`
- **Валідація**:
  - Перевіряє існування OTP для email
  - Порівнює bcrypt hash
  - Перевіряє термін дії (5 хвилин)
  - Видаляє OTP після успішної перевірки (одноразове використання)
- **Token**: JWT з секретом `JWT_RESET_SECRET`, дійсний 15 хвилин

#### POST `/api/password-reset/set-password`
**Крок 3:** Встановити новий пароль.
- **Body**: `{ token, password }` або `{ resetToken, password }`
- **Headers** (альтернатива): `Authorization: Bearer <resetToken>`
- **Query** (альтернатива): `?token=<resetToken>`
- **Response**: `{ message: "Password updated" }`
- **Дія**:
  - Верифікує reset token
  - Хешує новий пароль (bcrypt, 10 rounds)
  - Оновлює пароль користувача
  - Відправляє підтвердження на email (`password_changed`)

**Безпека:**
- OTP коди зберігаються як bcrypt hash (не plain text)
- Автоматичне видалення через TTL (MongoDB, 5 хвилин)
- Одноразове використання OTP
- Окремий JWT секрет для reset токенів
- Rate limiting на запити OTP
- Короткий термін дії reset токена (15 хвилин)

**Email шаблони:**
- `password_otp` - Лист з 6-значним кодом
- `password_changed` - Підтвердження зміни пароля

---

### �👤 Користувачі (`/api/users`)

#### GET `/api/users/profile`
Профіль користувача (auth required).
- **Response**: `{ user, addresses, defaultAddressId }`

#### PUT `/api/users/profile`
Оновити профіль.
- **Body**: `{ name, phone, email }`

#### POST `/api/users/addresses`
Додати нову адресу.
- **Body**: `{ label, line1, city, state, zip, county }`

#### PUT `/api/users/addresses/:addressId`
Оновити адресу.

#### DELETE `/api/users/addresses/:addressId`
Видалити адресу.

#### PUT `/api/users/default-address`
Встановити адресу за замовчуванням.
- **Body**: `{ addressId }`

---

### 📅 Бронювання (`/api/bookings`)

#### GET `/api/bookings/next?addressId=<id>`
Отримати наступне бронювання для адреси.

#### GET `/api/bookings/all?addressId=<id>`
Всі бронювання для адреси.

#### POST `/api/bookings`
Створити нове бронювання.
- **Body**: `{ date, service, addressId, note, images? }`
- **Middleware**: auth, blacklist check
- **Валідація**: 
  - Перевірка активної підписки
  - Перевірка доступної capacity
  - Мінімум 3 дні між бронюваннями для тієї ж адреси

#### PUT `/api/bookings/:id`
Оновити бронювання.

#### DELETE `/api/bookings/:id`
Скасувати бронювання.

#### POST `/api/bookings/upload`
Завантажити зображення для бронювання.
- **Form data**: `files[]` (до 10 файлів, max 50MB)
- **Response**: `{ urls: [...] }` - URLs на S3

---

### 💳 Stripe (`/api/stripe`)

#### POST `/api/stripe/create-checkout-session`
Створити Stripe Checkout сесію для підписки.
- **Body**: `{ plan, email, addressId, code? }`
- **Response**: `{ id: sessionId }`

**Плани:**
- `basic` - $149/міс
- `plus` - $249/міс
- `premium` - $349/міс (рекомендований)
- `elite` - $499/міс

**Trial period:** 7 днів безкоштовно

---

### 🔔 Webhook (`/api/stripe/webhook`)

#### POST `/api/stripe/webhook`
Обробка Stripe webhooks.
- **Events**: 
  - `checkout.session.completed` - Створення підписки
  - `customer.subscription.updated` - Оновлення статусу
  - `customer.subscription.deleted` - Скасування підписки
  - `invoice.payment_succeeded` - Успішний платіж
  - `invoice.payment_failed` - Невдалий платіж

---

### 📊 Підписки (`/api/subscriptions`)

#### GET `/api/subscriptions/my`
Мої підписки (всі адреси).
- **Response**: `[ { _id, addressId, address, subscriptionType, status, ... } ]`

#### POST `/api/subscriptions/cancel`
Скасувати підписку.
- **Body**: `{ addressId }`
- **Note**: Фактично відбувається по телефону, це для логування

---

### 🤖 Чатбот (`/api/chatbot`)

#### POST `/api/chatbot/message`
Відправити повідомлення чатботу.
- **Body**: `{ message, sessionId?, lead? }`
- **Response**: `{ reply, sessionId, leadId? }`
- **AI Model**: OpenAI GPT-4o-mini
- **Features**:
  - Інформація про послуги та плани
  - Перевірка доступності слотів
  - Збір контактів лідів
  - Waitlist для зон поза зоною обслуговування

#### GET `/api/chatbot/slot`
Перевірити наступний доступний слот.

---

### 📅 Календар (`/api/calendar`)

#### GET `/api/calendar/available-slots?date=<YYYY-MM-DD>`
Отримати доступні слоти на дату.
- **Response**: `{ available: boolean, capacity: N, booked: N }`

#### GET `/api/calendar/next-available`
Наступна доступна дата.

---

### 👑 Адмін (`/api/admin`)

Всі endpoints вимагають адмін права (email === MAIL_ADMIN).

#### GET `/api/admin/users`
Список всіх користувачів.

#### GET `/api/admin/bookings`
Всі бронювання з фільтрами.

#### PUT `/api/admin/bookings/:id/status`
Змінити статус бронювання.
- **Body**: `{ status, reason? }`

#### POST `/api/admin/send-promo`
Відправити промо email.
- **Body**: `{ segment, template, subject?, preview? }`
- **Segments**: all / not_subscribed / basic / plus / premium / elite

#### GET `/api/admin/stats`
Статистика платформи.

---

### 👥 Реферали (`/api/referrals`)

#### POST `/api/referrals/invite`
Запросити друга.
- **Body**: `{ referredEmail }`
- **Reward**: 10% знижка для обох сторін

#### GET `/api/referrals/my`
Мої реферали.

---

### 💬 Відгуки (`/api/feedback`)

#### POST `/api/feedback`
Залишити відгук після візиту.
- **Body**: `{ bookingId, feedback, rating? }`

---

### 📊 Трекінг (`/api/track`)

#### POST `/api/track/event`
Трекінг подій для аналітики.
- **Body**: `{ event, userId?, properties? }`

---

## 🛡 Middleware

### 1. **auth.js** - JWT Аутентифікація
```javascript
// Перевіряє наявність та валідність JWT токена
// Додає req.user.id (MongoDB _id) до запиту
```
**Використання:** Додається до всіх захищених маршрутів.

---

### 2. **blacklist.js** - Чорний список
```javascript
// Перевіряє, чи не заблокований користувач
ensureNotBlacklisted(req, res, next)
```

---

### 3. **otpRateLimit.js** - Rate Limiting
Обмеження кількості запитів на OTP коди (захист від спаму).

```javascript
// In-memory rate limiter (для production краще використовувати Redis)
// Ліміт: 3 запити на хвилину на IP+email комбінацію
```

**Параметри:**
- **Window**: 60 секунд (1 хвилина)
- **Max requests**: 3 запити на вікно
- **Key**: `IP:email` (комбінація)
- **Response**: 429 Too Many Requests при перевищенні

**Використання:** Застосовується до `/api/password-reset` POST endpoint.

---

## 🧰 Утиліти

### 1. **emailService.js** - Email Сервіс

Використовує **AWS SES SMTP** через Nodemailer.

**Основні функції:**

#### `sendTx(templateId, to, data)`
Відправка транзакційних email з шаблонами.

**Доступні шаблони:**
- `nudge_subscribe` - Нагадування про підписку
- `nudge_lead_v1` - Follow-up лідам (~2 години)
- `nudge_lead_v2` - Follow-up лідам (~48 годин)
- `booking_confirmed` - Підтвердження бронювання
- `booking_reminder` - Нагадування про візит
- `booking_completed` - Завершення візиту
- `welcome` - Вітальний лист
- `subscription_renewed` - Оновлення підписки
- `subscription_canceled` - Скасування підписки
- `password_otp` - 6-значний OTP код для відновлення пароля
- `password_changed` - Підтвердження зміни пароля

#### `sendPromo(template, to, data)`
Відправка промо/маркетингових листів.

**Стилізація:** Всі email включають брендовий дизайн з логотипом, кольорами (#6f48eb), та responsive layout.

---

### 2. **s3.js** - AWS S3
```javascript
putPublicObject(key, buffer, contentType)
```
Завантаження файлів на S3 з публічним доступом.

**Bucket:** `process.env.S3_BUCKET`  
**Prefix:** `uploads/`

---

### 3. **getNextAvailableSlot.js**
```javascript
getNextAvailableSlot(startDate?)
```
Знаходить наступну доступну дату для бронювання з урахуванням capacity та вимкнених дат.

---

## ⏰ Автоматизація (CRON)

Backend використовує `node-cron` для автоматичних задач.

### 1. **Weekly Nudge** (щотижня)
**Розклад:** Кожен понеділок о 10:00 AM (America/New_York)
```javascript
"0 10 * * 1"
```
**Що робить:**
- Знаходить користувачів без активної підписки
- Відправляє `nudge_subscribe` email (до 5000 користувачів)
- Пакетна відправка по 10 листів з затримкою 400ms

**Вимкнути:** `WEEKLY_NUDGE_ENABLED=false`

---

### 2. **Chatbot Follow-ups** (щогодини)
**Розклад:** Щогодини о 12-й хвилині
```javascript
"12 * * * *"
```
**Що робить:**

**Wave 1** (≈2 години після контакту):
- Знаходить ліди зі статусом `engaged`
- Які створені >2 години тому
- Ще не отримали followup1
- Відправляє `nudge_lead_v1`

**Wave 2** (≈48 годин після контакту):
- Знаходить ліди після followup1
- Які створені >48 годин тому
- Ще не отримали followup2
- Відправляє `nudge_lead_v2`

**Ліміт:** 500 лідів на wave  
**Rate:** ~14 emails/sec (70ms delay)  
**Вимкнути:** `CHATBOT_FOLLOWUPS_ENABLED=false`

---

## 🔗 Інтеграції

### 1. **Stripe** (платежі)
- Subscription checkout sessions
- Webhook обробка подій
- Промо коди (наприклад, FIX10 для 10% знижки)
- Trial period: 7 днів

**Env vars:**
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`

---

### 2. **AWS SES** (email)
- SMTP для транзакційних листів
- Шаблони з HTML + inline CSS
- Rate limiting для безпеки

**Env vars:**
- `AWS_SES_SMTP_HOST`
- `AWS_SES_SMTP_USER`
- `AWS_SES_SMTP_PASS`

---

### 3. **AWS S3** (файли)
- Публічне зберігання зображень до бронювань
- Automatic redirects: `/uploads/*` → S3 URL

**Env vars:**
- `S3_BUCKET`
- `S3_PREFIX` (за замовчуванням: "uploads")
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_REGION`

---

### 4. **OpenAI** (чатбот)
- Model: GPT-4o-mini
- Streaming responses
- Context: Chatbot knowledge base
- Integration з getNextAvailableSlot()

**Env var:**
- `OPENAI_API_KEY`

**Fallback:** Якщо ключ відсутній, використовується stub відповідь.

---

### 5. **Facebook Conversion API** (трекінг)
- Трекінг конверсій для реклами
- Events: Lead, Subscribe, Purchase

**Controller:** `controllers/facebookCapi.js`

---

## ⚙️ Налаштування та змінні оточення

### Обов'язкові змінні:

```bash
# MongoDB
MONGO_URI=mongodb+srv://...

# JWT секрети
JWT_SECRET=your_jwt_secret_here
JWT_RESET_SECRET=your_reset_secret_here

# Stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# AWS SES (Email)
AWS_SES_SMTP_HOST=email-smtp.us-east-1.amazonaws.com
AWS_SES_SMTP_USER=AKIA...
AWS_SES_SMTP_PASS=...

# AWS S3 (Files)
S3_BUCKET=your-bucket-name
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1

# OpenAI (Chatbot)
OPENAI_API_KEY=sk-...

# Email адреси
MAIL_FROM=Profixter <no-reply@profixter.com>
MAIL_REPLY_TO=getfixter@gmail.com
MAIL_ADMIN=getfixter@gmail.com

# URLs
SITE_URL=https://profixter.com
FRONTEND_URL=https://profixter.com
```

### Опціональні змінні:

```bash
# Порт (за замовчуванням 5000)
PORT=5000

# S3 prefix (за замовчуванням "uploads")
S3_PREFIX=uploads

# CRON вимикачі
WEEKLY_NUDGE_ENABLED=true
CHATBOT_FOLLOWUPS_ENABLED=true

# Brand URLs
TIP_LINK=https://buy.stripe.com/...
REVIEW_URL=https://maps.app.goo.gl/...
PLANS_URL=https://profixter.com/subscription
SCHEDULE_URL=https://profixter.com/schedule
```

---

## 🚀 Запуск проекту

### Development режим:
```bash
cd backend
npm install
npm run dev  # nodemon server.js
```

### Production режим:
```bash
npm start  # node server.js
```

### Міграційні скрипти:
```bash
npm run migrate:addresses        # Міграція адрес
npm run migrate:subs-addr        # Backfill підписок з адресами
npm run audit:subs              # Аудит підписок (dry run)
npm run fix:subs                # Виправлення підписок
```

---

## 📡 CORS налаштування

Дозволені origins:
```javascript
[
  "http://localhost:3000",
  "http://handyman-frontend-v1.s3-website-us-east-1.amazonaws.com",
  "http://handyman-v2-env.eba-fq3ppgr4.us-east-1.elasticbeanstalk.com",
  "http://profixter.com",
  "https://profixter.com",
  "http://www.profixter.com",
  "https://www.profixter.com",
]
```

**Credentials:** `true`  
**Methods:** `GET, POST, PUT, DELETE`  
**Headers:** `Authorization, Content-Type`

---

## 📊 Статус та моніторинг

### Health checks:
- MongoDB connection з синхронізацією індексів
- JWT secrets наявність при старті
- Test query на User колекцію

### Логування:
```
✅ MongoDB Connected
✅ User indexes in sync
✅ MongoDB Test Passed
✅ JWT_RESET_SECRET present
🚀 Server running on port 5000
```

---

## 🔒 Безпека

1. **Аутентифікація:** JWT токени (httpOnly cookies + Bearer token)
2. **Паролі:** bcryptjs hashing (salt rounds: 10)
3. **Rate Limiting:** OTP requests
4. **Blacklist:** Middleware для блокування зловмисників
5. **CORS:** Обмежені origins
6. **Webhook verification:** Stripe signature перевірка
7. **Input sanitization:** Mongoose схеми + validation

---

## 📝 Примітки для розробників

### Множинні адреси:
Проект переходить від single address (legacy) до multiple addresses per user:
- `User.addresses` - масив адрес
- `User.defaultAddressId` - адреса за замовчуванням
- `Subscription.addressId` - підписка прив'язана до конкретної адреси
- `Booking.addressId` - бронювання для конкретної адреси

### Міграція:
Є скрипти для міграції legacy даних. Користувачі з одною адресою автоматично мігруються при логіні/профілі запитах.

### Timezone:
Всі CRON задачі та календар використовують `America/New_York` timezone.

### Capacity management:
- `CalendarConfig` - конфігурація capacity per day
- `SlotCounter` - лічильник зайнятих слотів
- Валідація при створенні бронювання

### Email templates:
Всі транзакційні email включають:
- Responsive HTML design
- Brand colors та логотип
- CTAs з tracking
- Unsubscribe links для маркетингових листів

---

## 🎨 Брендинг

**Назва:** Mr. Fixter / Profixter  
**Колір:** `#6f48eb` (фіолетовий)  
**Логотип:** `mrfixter-logoBlackText.png` (S3)  
**Домен:** profixter.com  
**Зона обслуговування:** Nassau County, Suffolk County, NY  

---

## 📞 Контакти та підтримка

**Email:** getfixter@gmail.com  
**Phone:** +1 (631) 599-1363  
**Website:** https://profixter.com  
**Google Reviews:** https://maps.app.goo.gl/65L1i4GGsd1nMWEi7

---

## 📄 Ліцензія

Проприєтарне ПЗ. Всі права захищені.

---

**Дата створення документації:** 19 листопада 2025 р.  
**Версія:** 1.0.0  
**Автор:** Backend Documentation Generator

---

_Ця документація охоплює поточний стан backend додатку. Для змін або доповнень зверніться до розробників._
