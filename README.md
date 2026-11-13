
# MyContest PubScale Backend

Dedicated Node.js backend for PubScale Offerwall integration in the MyContest Android application.

## Features

- PubScale Server-to-Server (S2S) callbacks
- Callback signature verification
- Duplicate transaction protection
- Firebase Firestore transaction storage
- Reward verification
- Health check endpoint

## Technology

- Node.js
- Express.js
- Firebase Admin SDK
- Firestore
- Render Hosting

## API Endpoints

### Health Check

GET /pubscale/health

### PubScale Callback

GET /pubscale/callback

Required parameters:

- user_id
- value
- token
- signature

## Environment Variables

Configure these variables in Render:

- PORT
- PUBSCALE_SECRET_KEY
- FIREBASE_SERVICE_ACCOUNT_JSON

Never upload actual secret keys or Firebase private credentials to GitHub.

## Firestore Collection

pubscale_transactions

Verified callbacks are stored with duplicate transaction protection.

## Deployment

1. Connect this GitHub repository to Render.
2. Select Web Service.
3. Build Command: npm install
4. Start Command: npm start
5. Add required environment variables.
6. Deploy the service.

## Important

This backend is separate from the existing AYET and GemK backends.

Do not credit rewards to the main wallet until callback verification, reward mapping, chargeback handling, and wallet integration have been tested.

## Project

MyContest - PubScale Offerwall Integration
