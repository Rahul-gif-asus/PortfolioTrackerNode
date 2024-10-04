// Import necessary libraries
const express = require('express');
const { MongoClient } = require('mongodb');
const { SmartAPI } = require('smartapi-javascript');
const { authenticator } = require('otplib');
const axios = require('axios');
const { format, subDays, isWeekend } = require('date-fns');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');

// Initialize Express app
const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const PORT = 3000;

// Serve static files (like index.html) from the current directory
app.use(express.static(path.join(__dirname)));

// MongoDB connection
const mongoUri = "mongodb+srv://SupremeRahul:OptimusPrime@clusternse.wpf8cel.mongodb.net/";
const client = new MongoClient(mongoUri);
let db;

(async () => {
  await client.connect();
  db = client.db('SmartAPI');
})();

const portfolioCollection = () => db.collection('Angelone Overall Portfolio Track');
const stocksCollection = () => db.collection('Angelone Stocks Portfolio Track');
const credentialsCollection = () => db.collection('Angelone Portfolio Tracking User Credentials');
const portfolioLogsCollection = () => db.collection('PortfolioLogs');

// Function to generate the TOTP for 2FA
function generateTotp(totpSecret) {
  return authenticator.generate(totpSecret);
}

// Logger function to log with timestamp and store in logs array
function logWithTimestamp(message, logsArray, socket) {
  const timestamp = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
  const logMessage = `[${timestamp}] ${message}`;
  console.log(logMessage);
  fs.appendFileSync(path.join(__dirname, 'server.log'), logMessage + '\n');
  logsArray.push({ timestamp, message });
  if (socket) {
    socket.emit('log', logMessage); // Send log to the client in real-time
  }
}

// Login and fetch portfolio data
async function loginAndFetchPortfolio(apiKey, username, password, totpSecret, logs, socket) {
  const obj = new SmartAPI({ api_key: apiKey, client_id: username, password: password, totp: generateTotp(totpSecret) });
  try {
    logWithTimestamp("Logging in and fetching portfolio data...", logs, socket);
    const data = await obj.generateSession(username, password, generateTotp(totpSecret));
    const refreshToken = data.data.refreshToken;
    const profileData = await obj.getProfile(refreshToken);
    const userName = profileData.data.name.trim();
    const clientCode = profileData.data.clientcode;
    logWithTimestamp(`Successfully logged in as ${userName} with client code ${clientCode}`, logs, socket);
    return { obj, refreshToken, userName, clientCode };
  } catch (error) {
    throw new Error(`Error during login: ${error}`);
  }
}

// Simulated list of NSE trading holidays
const TRADING_HOLIDAYS = [
  "2024-03-29", // Holi
  "2024-08-15", // Independence Day
  "2024-10-02", // Gandhi Jayanti
];

// Check if the given date is a trading holiday
function isTradingHoliday(date) {
  return TRADING_HOLIDAYS.includes(format(date, 'yyyy-MM-dd'));
}

// Find the most recent working day, skipping weekends and holidays
function findPreviousWorkingDay(date) {
  while (isWeekend(date) || isTradingHoliday(date)) {
    date = subDays(date, 1);
  }
  return date;
}

// Fetch dates for historical OHLC data
function fetchDates(logs, socket) {
  logWithTimestamp("Fetching dates for historical OHLC data...", logs, socket);
  const now = new Date();
  const fixedTime1 = "09:15";
  const fixedTime2 = "15:30";

  let fromDate, toDate;

  if (isWeekend(now) || isTradingHoliday(now)) {
    const previousDay = findPreviousWorkingDay(subDays(now, 1));
    logWithTimestamp(`Today is a non-working day. Previous working day: ${format(previousDay, 'yyyy-MM-dd')}`, logs, socket);
    fromDate = findPreviousWorkingDay(subDays(previousDay, 1));
    toDate = previousDay;
  } else {
    fromDate = subDays(now, 1);
    toDate = now;
  }

  const fromDateStr = `${format(fromDate, 'yyyy-MM-dd')} ${fixedTime1}`;
  const toDateStr = `${format(toDate, 'yyyy-MM-dd')} ${fixedTime2}`;

  logWithTimestamp(`From date: ${fromDateStr}, To date: ${toDateStr}`, logs, socket);
  return [fromDateStr, toDateStr];
}

// Fetch historical OHLC data
async function fetchHistoricalOhlc(obj, symbol, token, logs, socket) {
  try {
    logWithTimestamp(`Fetching OHLC data for ${symbol}...`, logs, socket);
    const [fromDate, toDate] = fetchDates(logs, socket);
    await new Promise(resolve => setTimeout(resolve, 500)); // Slow down to avoid rate-limit issues
    const historicalParams = {
      exchange: "NSE",
      symboltoken: token,
      interval: "ONE_DAY",
      fromdate: fromDate,
      todate: toDate,
    };
    const response = await obj.getCandleData(historicalParams);
    if (response.data && response.data.length > 0) {
      logWithTimestamp(`Previous close for ${symbol}: ${response.data[0][4]}`, logs, socket);
      return response.data[0][4]; // Return the closing price
    } else {
      throw new Error(`No historical data found for ${symbol}`);
    }
  } catch (error) {
    logWithTimestamp(`Error fetching OHLC data for ${symbol}: ${error}`, logs, socket);
    return { error: error.message };
  }
}

// Backoff mechanism for handling API rate-limit errors
async function fetchWithBackoff(apiCall, retries = 5, backoffFactor = 1, logs, socket) {
  for (let i = 0; i < retries; i++) {
    try {
      return await apiCall();
    } catch (error) {
      if (error.message.includes("exceeding access rate")) {
        const waitTime = backoffFactor * Math.pow(2, i);
        logWithTimestamp(`Rate limit exceeded. Retrying in ${waitTime} seconds...`, logs, socket);
        await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
      } else {
        throw error;
      }
    }
  }
  throw new Error("Failed after maximum retries");
}

// Fetch the trade book
async function fetchTradeBook(obj, logs, socket) {
  const tradeBook = await obj.getTradeBook();
  if (tradeBook.status && tradeBook.data) {
    return tradeBook.data;
  } else {
    return []; // Return an empty list if there are no trades
  }
}

// Check if the stock was bought today
function isStockBoughtToday(stock, trades) {
  if (!trades.length) return { boughtToday: false, price: null, size: 0 };
  for (const trade of trades) {
    if (trade.tradingsymbol === stock.tradingsymbol && trade.transactiontype === 'BUY') {
      return { boughtToday: true, price: parseFloat(trade.fillprice), size: parseInt(trade.fillsize, 10) };
    }
  }
  return { boughtToday: false, price: null, size: 0 };
}

// Update portfolio data
async function updatePortfolioData(obj, userName, clientCode, logs, socket) {
  const todayDate = format(new Date(), 'dd-MM-yyyy');

  async function fetchHoldings(obj) {
    return obj.getHolding();
  }

  try {
    logWithTimestamp(`Fetching user holdings for ${userName} with client code ${clientCode}...`, logs, socket);
    const allHoldingData = await fetchWithBackoff(() => fetchHoldings(obj), 5, 1, logs, socket);

    if (!allHoldingData || !allHoldingData.data) {
      throw new Error(`Holdings data is undefined or unavailable for ${userName}`);
    }

    const holdingsData = allHoldingData.data;
    logWithTimestamp(`Holdings fetched: ${holdingsData.length} stocks for ${userName}`, logs, socket);

    const tradeBook = await fetchTradeBook(obj, logs, socket);
    let totalTodayGain = 0;

    const clientEntry = await stocksCollection().findOne({ ClientCode: clientCode });
    if (clientEntry) {
      logWithTimestamp(`Client ${clientCode} found in the database.`, logs, socket);
    } else {
      logWithTimestamp(`Client ${clientCode} not found, creating new entry for the client.`, logs, socket);
    }

    for (const stock of holdingsData) {
      logWithTimestamp(`Processing stock: ${stock.tradingsymbol}`, logs, socket);
      const { boughtToday, price, size } = isStockBoughtToday(stock, tradeBook);

      let todayGain = 0;
      if (boughtToday) {
        todayGain = (stock.ltp - price) * size;
        const oldQuantity = stock.quantity - size;
        if (oldQuantity > 0) {
          todayGain += (stock.ltp - stock.close) * oldQuantity;
        }
        logWithTimestamp(`Stock ${stock.tradingsymbol} was bought today. Calculated today_gain: ${todayGain}`, logs, socket);
      } else {
        todayGain = (stock.ltp - stock.close) * stock.quantity;
        logWithTimestamp(`Stock ${stock.tradingsymbol} was held from previous days. Calculated today_gain: ${todayGain}`, logs, socket);
      }
      totalTodayGain += todayGain;

      try {
        logWithTimestamp(`Ensuring stock ${stock.tradingsymbol} has entry for ${todayDate}`, logs, socket);
        await stocksCollection().updateOne(
          {
            ClientCode: clientCode,
            'PortfolioStocks.stockName': stock.tradingsymbol,
          },
          {
            $set: {
              'PortfolioStocks.$.entries': {
                date: todayDate,
                exchange: stock.exchange,
                quantity: stock.quantity,
                realisedquantity: stock.realisedquantity,
                authorisedquantity: stock.authorisedquantity,
                product: stock.product,
                averageprice: stock.averageprice,
                symboltoken: stock.symboltoken,
                overallPnL: stock.profitandloss,
                pnlpercentage: stock.pnlpercentage,
                todayGain: parseFloat(todayGain.toFixed(2)),
              },
            },
          },
          { upsert: true }
        );
        logWithTimestamp(`Successfully added or updated stock ${stock.tradingsymbol} for ${todayDate}`, logs, socket);
      } catch (error) {
        logWithTimestamp(`Error adding or updating stock ${stock.tradingsymbol} for ${todayDate}: ${error}`, logs, socket);
      }
    }

    // Update total portfolio details
    try {
      logWithTimestamp(`Updating total portfolio for ${clientCode} on ${todayDate}`, logs, socket);
      await portfolioCollection().updateOne(
        { ClientCode: clientCode },
        {
          $set: {
            Portfolio: {
              date: todayDate,
              totalholdingvalue: parseFloat(totalTodayGain.toFixed(2)),
              totalinvvalue: parseFloat(totalTodayGain.toFixed(2)),
              totalprofitandloss: parseFloat(totalTodayGain.toFixed(2)),
              totalpnlpercentage: 0,
              totalTodayGain: parseFloat(totalTodayGain.toFixed(2)),
            },
          },
        },
        { upsert: true }
      );
      logWithTimestamp(`Total portfolio gain today for ${userName}: ${totalTodayGain}`, logs, socket);
    } catch (error) {
      logWithTimestamp(`Error updating portfolio for ${userName}: ${error}`, logs, socket);
    }
  } catch (error) {
    logWithTimestamp(`Error fetching holdings data for ${userName}: ${error}`, logs, socket);
  }
}

// Function to handle each user's portfolio update
async function processUserPortfolio(user, socket) {
  const { apiKey, clientId, password, totp_secret: totpSecret } = user;
  const logs = [];

  try {
    const { obj, refreshToken, userName, clientCode } = await loginAndFetchPortfolio(apiKey[0], clientId, password, totpSecret, logs, socket);
    await updatePortfolioData(obj, userName, clientCode, logs, socket);

    // Store logs in PortfolioLogs collection (overwrite for the day)
    await portfolioLogsCollection().updateOne(
      { clientId: clientCode, date: format(new Date(), 'yyyy-MM-dd') },
      {
        $set: {
          clientId: clientCode,
          clientName: userName,
          date: format(new Date(), 'yyyy-MM-dd'),
          logs
        }
      },
      { upsert: true }
    );

    return { clientId: clientCode, clientName: userName, status: 'Successfully processed portfolio', logs };
  } catch (error) {
    logWithTimestamp(`Error processing portfolio for ${user.clientName}: ${error}`, logs, socket);
    await portfolioLogsCollection().updateOne(
      { clientId: user.clientId, date: format(new Date(), 'yyyy-MM-dd') },
      {
        $set: {
          clientId: user.clientId,
          clientName: user.clientName,
          date: format(new Date(), 'yyyy-MM-dd'),
          logs
        }
      },
      { upsert: true }
    );
    return { clientId: user.clientId, clientName: user.clientName, status: `Error: ${error.message}`, logs };
  }
}

// Socket.io connection for real-time logs
io.on('connection', (socket) => {
  console.log('Client connected');
  socket.on('startPortfolioUpdate', async () => {
    try {
      const allLogs = [];
      logWithTimestamp("Starting the portfolio update process for all users...", allLogs, socket);
      const allUsers = await credentialsCollection().find().toArray();
      const logPromises = allUsers.map(user => processUserPortfolio(user, socket));
      const logs = await Promise.all(logPromises);
      socket.emit('updateComplete', { message: 'Portfolio update process completed successfully', logs });
    } catch (error) {
      logWithTimestamp(`An error occurred while iterating through users: ${error}`, allLogs, socket);
      socket.emit('updateError', { message: 'An error occurred while updating portfolios', error: error.message });
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

// Root route for GET request
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Start the server
server.listen(PORT, () => {
  logWithTimestamp(`Server running on http://localhost:${PORT}`, []);
});