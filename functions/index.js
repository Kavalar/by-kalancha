const functions = require("firebase-functions/v2");
const admin = require("firebase-admin");
const sgMail = require("@sendgrid/mail");
const cors = require("cors")({ origin: true });

admin.initializeApp();
const db = admin.firestore();

// Визначаємо параметр для ключа SendGrid. Його треба налаштувати в консолі.
const sendgridApiKey = functions.params.defineString("SENDGRID_API_KEY");

// 1. ОНОВЛЕНА ФУНКЦІЯ для ручної відправки та щоденних звітів
exports.generateAndSendReport = functions.https.onRequest(
  { params: [sendgridApiKey], memory: '256MiB', region: 'europe-central2' },
  async (request, response) => {
    cors(request, response, async () => {
      try {
        let { startDate, endDate } = request.body.data || {};
        let start, end, reportPeriodTitle;

        // Визначаємо період звіту
        if (startDate && endDate) {
            start = new Date(startDate);
            end = new Date(endDate);
            const dateOptions = { day: 'numeric', month: 'long', year: 'numeric' };
            reportPeriodTitle = `з ${start.toLocaleDateString('uk-UA', dateOptions)} по ${end.toLocaleDateString('uk-UA', dateOptions)}`;
        } else {
            const today = new Date();
            today.setHours(0,0,0,0);
            const yesterday = new Date(today);
            yesterday.setDate(today.getDate() - 1);
            start = yesterday;
            end = new Date(today.getTime() - 1); 
            reportPeriodTitle = `за ${start.toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' })}`;
        }
        
        end.setHours(23, 59, 59, 999);

        // Збираємо дані
        const appointmentsSnap = await db.collection("appointments")
          .where("status", "==", "completed")
          .where("completedAt", ">=", admin.firestore.Timestamp.fromDate(start))
          .where("completedAt", "<=", admin.firestore.Timestamp.fromDate(end))
          .get();
        
        if (appointmentsSnap.empty) {
          console.log(`За період ${reportPeriodTitle} немає оплачених записів.`);
          response.send({ data: { success: true, message: "За обраний період немає оплачених записів." } });
          return;
        }

        const servicesSnap = await db.collection("services").get();
        const services = servicesSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

        // === ЗМІНА ТУТ: Додано blikRevenue ===
        let cardRevenue = 0, cashRevenue = 0, blikRevenue = 0;
        const servicePopularity = {};

        appointmentsSnap.docs.forEach((doc) => {
          const app = doc.data();
          // === ЗМІНА ТУТ: Коректний підрахунок по типам ===
          if (app.paymentType === "card") {
              cardRevenue += app.finalPrice;
          } else if (app.paymentType === "cash") {
              cashRevenue += app.finalPrice;
          } else if (app.paymentType === "blik") {
              blikRevenue += app.finalPrice;
          }
          servicePopularity[app.serviceId] = (servicePopularity[app.serviceId] || 0) + 1;
        });

        const totalRevenue = cardRevenue + cashRevenue + blikRevenue;
        const servicesCount = appointmentsSnap.size;

        let mostPopularService = "Немає";
        if (Object.keys(servicePopularity).length > 0) {
          const mostPopularId = Object.keys(servicePopularity).reduce((a, b) => servicePopularity[a] > servicePopularity[b] ? a : b);
          const serviceInfo = services.find((s) => s.id === mostPopularId);
          if (serviceInfo) mostPopularService = `${serviceInfo.name} (${servicePopularity[mostPopularId]})`;
        }
        
        const reportTitle = `🔔 Звіт ${reportPeriodTitle}`;
        // === ЗМІНА ТУТ: Додано рядок для Blik ===
        const reportBody = `----------------------------\n💳 Карткою: ${cardRevenue.toFixed(0)} zł\n💵 Готівкою: ${cashRevenue.toFixed(0)} zł\n📱 Blik: ${blikRevenue.toFixed(0)} zł\n📊 Разом: ${totalRevenue.toFixed(0)} zł\n\nПослуг надано: ${servicesCount}\nНайпопулярніше: ${mostPopularService}\n----------------------------`;
        
        const settingsDoc = await db.collection("settings").doc("reports").get();
        const recipients = settingsDoc.exists ? settingsDoc.data().recipients : [];

        if (recipients.length === 0) {
          throw new functions.https.HttpsError("not-found", "Не вказано жодного отримувача звіту в налаштуваннях.");
        }
        
        sgMail.setApiKey(sendgridApiKey.value());
        // УВАГА: Для уникнення спаму, 'from' має бути верифікованим доменом у SendGrid
        const msg = { to: recipients, from: "s.pepelniy@gmail.com", subject: reportTitle, text: reportBody };

        await sgMail.send(msg);
        response.send({ data: { success: true, message: "Звіт успішно сформовано та відправлено!" } });

      } catch (error) {
          console.error("Помилка у хмарній функції:", error);
          response.status(500).send({ error: "Внутрішня помилка сервера." });
      }
    });
  }
);


// 2. НОВА ФУНКЦІЯ для щотижневого звіту
exports.sendWeeklyReport = functions.scheduler.onSchedule(
  {
    schedule: 'every monday 09:00',
    timeZone: 'Europe/Warsaw',
    params: [sendgridApiKey],
    memory: '256MiB',
    region: 'europe-central2'
  },
  async (event) => {
    console.log('Початок генерації щотижневого звіту.');
    try {
        const today = new Date();
        const endDate = new Date(today);
        endDate.setDate(today.getDate() - 1);
        endDate.setHours(23, 59, 59, 999);
        const startDate = new Date(endDate);
        startDate.setDate(endDate.getDate() - 6);
        startDate.setHours(0, 0, 0, 0);

        const appointmentsSnap = await db.collection("appointments").where("status", "==", "completed").where("completedAt", ">=", startDate).where("completedAt", "<=", endDate).get();
        
        if (appointmentsSnap.empty) {
            console.log(`За тиждень ${startDate.toLocaleDateString('uk-UA')} - ${endDate.toLocaleDateString('uk-UA')} немає оплачених записів.`);
            return null;
        }

        let cardRevenue = 0, cashRevenue = 0, blikRevenue = 0;
        appointmentsSnap.docs.forEach(doc => {
            const app = doc.data();
            if (app.paymentType === "card") cardRevenue += app.finalPrice;
            else if (app.paymentType === "cash") cashRevenue += app.finalPrice;
            else if (app.paymentType === "blik") blikRevenue += app.finalPrice;
        });

        const totalRevenue = cardRevenue + cashRevenue + blikRevenue;
        const reportTitle = `🗓️ Тижневий звіт CRM: ${startDate.toLocaleDateString('uk-UA')} - ${endDate.toLocaleDateString('uk-UA')}`;
        const reportBody = `Загальна статистика за минулий тиждень:\n----------------------------\n💳 Карткою: ${cardRevenue.toFixed(0)} zł\n💵 Готівкою: ${cashRevenue.toFixed(0)} zł\n📱 Blik: ${blikRevenue.toFixed(0)} zł\n📊 Разом: ${totalRevenue.toFixed(0)} zł\n\nВсього послуг надано: ${appointmentsSnap.size}\n----------------------------`;

        const settingsDoc = await db.collection("settings").doc("reports").get();
        const recipients = settingsDoc.exists ? settingsDoc.data().recipients : [];
        if (recipients.length === 0) return null;

        sgMail.setApiKey(sendgridApiKey.value());
        await sgMail.send({ to: recipients, from: "s.pepelniy@gmail.com", subject: reportTitle, text: reportBody });

        console.log('Щотижневий звіт успішно відправлено!');
    } catch (error) {
        console.error('Помилка при відправці щотижневого звіту:', error);
        if (error.response) { console.error(error.response.body); }
    }
    return null;
  }
);


// 3. НОВА ФУНКЦІЯ для щомісячного звіту
exports.sendMonthlyReport = functions.scheduler.onSchedule(
  {
    schedule: '1 of month 09:30',
    timeZone: 'Europe/Warsaw',
    params: [sendgridApiKey],
    memory: '256MiB',
    region: 'europe-central2'
  },
  async (event) => {
    console.log('Початок генерації щомісячного звіту.');
    try {
        const today = new Date();
        const endDate = new Date(today.getFullYear(), today.getMonth(), 0);
        endDate.setHours(23, 59, 59, 999);
        const startDate = new Date(endDate.getFullYear(), endDate.getMonth(), 1);
        startDate.setHours(0, 0, 0, 0);

        const monthName = startDate.toLocaleString('uk-UA', { month: 'long', year: 'numeric' });
        const appointmentsSnap = await db.collection("appointments").where("status", "==", "completed").where("completedAt", ">=", startDate).where("completedAt", "<=", endDate).get();
        
        if (appointmentsSnap.empty) {
            console.log(`За ${monthName} немає оплачених записів.`);
            return null;
        }

        let cardRevenue = 0, cashRevenue = 0, blikRevenue = 0;
        appointmentsSnap.docs.forEach(doc => {
            const app = doc.data();
            if (app.paymentType === "card") cardRevenue += app.finalPrice;
            else if (app.paymentType === "cash") cashRevenue += app.finalPrice;
            else if (app.paymentType === "blik") blikRevenue += app.finalPrice;
        });

        const totalRevenue = cardRevenue + cashRevenue + blikRevenue;
        const reportTitle = `📅 Місячний звіт CRM за ${monthName}`;
        const reportBody = `Загальна статистика за ${monthName}:\n----------------------------\n💳 Карткою: ${cardRevenue.toFixed(0)} zł\n💵 Готівкою: ${cashRevenue.toFixed(0)} zł\n📱 Blik: ${blikRevenue.toFixed(0)} zł\n📊 Разом: ${totalRevenue.toFixed(0)} zł\n\nВсього послуг надано: ${appointmentsSnap.size}\n----------------------------`;

        const settingsDoc = await db.collection("settings").doc("reports").get();
        const recipients = settingsDoc.exists ? settingsDoc.data().recipients : [];
        if (recipients.length === 0) return null;

        sgMail.setApiKey(sendgridApiKey.value());
        await sgMail.send({ to: recipients, from: "s.pepelniy@gmail.com", subject: reportTitle, text: reportBody });

        console.log('Щомісячний звіт успішно відправлено!');
    } catch (error) {
        console.error('Помилка при відправці щомісячного звіту:', error);
        if (error.response) { console.error(error.response.body); }
    }
    return null;
  }
);