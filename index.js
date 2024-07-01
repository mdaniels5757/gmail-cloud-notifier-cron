/**
 * Original: Copyright 2018, Google LLC
 * Modifications: Copyright 2024, Michael Daniels
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

const { google } = require('googleapis');
const oauth = require('./lib/oauth');
const gmail = google.gmail({ version: 'v1', auth: oauth.client });
const bunyan = require('bunyan');
const { LoggingBunyan } = require('@google-cloud/logging-bunyan');
const loggingBunyan = new LoggingBunyan({
  redirectToStdout: true,
  skipParentEntryForCloudRun: true
});
const logger = bunyan.createLogger({
  name: 'gmail-notifier',
  src: true,
  streams: [
    loggingBunyan.stream('debug')
  ]
});
const { Datastore } = require('@google-cloud/datastore');
const datastore = new Datastore({ databaseId: 'gmail-notifier' });
const fetch = require('node-fetch');

/**
 * Given a gmail message and a header name, get the corresponding header value (if it exists)
 * @param {Schema$Message} msg A Gmail message object.
 * @param {string} headerName The name of the header (e.g. 'Subject')
 * @returns {string} The corresponding header value (if it exists), otherwise a corresponding message.
 */
function getHeaderValue (msg, headerName) {
  for (const header of msg.payload.headers) {
    if (header.name === headerName) {
      return header.value;
    }
  }

  return '[no subject]';
}

async function sendMessage (msg, emailAddress) {
  const androidUrl = 'googlegmail:///cv=' + msg.id;
  const webUrl = 'https://mail.google.com/mail?authuser=' + emailAddress + '#all/' + msg.id;
  const params = new URLSearchParams();
  params.append('token', process.env.PUSHOVER_API_KEY);
  params.append('user', process.env.PUSHOVER_USER_KEY);
  params.append('title', 'New email: ' + getHeaderValue(msg, 'Subject'));
  params.append('message', 'From: ' + getHeaderValue(msg, 'From') + '\n' +
      'To: ' + getHeaderValue(msg, 'To') + '\n' +
      'Web URL: ' + webUrl + '\n' +
      'Android URL: ' + androidUrl);
  params.append('url', androidUrl);
  params.append('url_title', 'Open in Gmail for Android');

  // const body = {
  //   token: process.env.PUSHOVER_API_KEY,
  //   user: process.env.PUSHOVER_USER_KEY,
  //   title: 'New email: ' + getHeaderValue(msg, 'Subject'),
  //   message: 'From: ' + getHeaderValue(msg, 'From') + '\n' +
  //     'To: ' + getHeaderValue(msg, 'To') + '\n' +
  //     'Web URL: ' + webUrl + '\n' +
  //     'Android URL: ' + androidUrl,
  //   url: androidUrl,
  //   url_title: 'Open in Gmail for Android'
  // }

  const response = await fetch(
    'https://api.pushover.net/1/messages.json',
    {
      method: 'POST',
      body: params
    }
  );

  const data = await response.json();

  return data;
}

/**
* Process new messages as they are received
*/
exports.cronJob = (event) => {
  logger.info({ entry: 'New event!' });
  logger.debug({ entry: 'Raw event:\n' + JSON.stringify(event, null, 4) });

  // const eventDataStr = Buffer.from(event.data, 'base64').toString('ascii');
  // const eventDataObj = JSON.parse(eventDataStr);
  // logger.info({ event: 'Parsed event: ' + JSON.stringify(eventDataObj, null, 4) });
  const emailAddress = eventDataObj.attributes.emailAddress;

  oauth.fetchToken(emailAddress)
    .then(() => {
      return Promise.all([
        datastore.get({
          key: datastore.key(['lastRunTime', emailAddress])
        })
          .then((lastRunTimeObj) => lastRunTimeObj.lastRunTime),
        datastore.get({
          key: datastore.key(['query', emailAddress])
        })
          .then((queryObj) => queryObj.query)
      ]);
    })
    .then((lastRunTime, query) => {
      logger.info({
        event: 'lastRunTime is "' + lastRunTime + '" as str, "' +
          parseInt(lastRunTime, 10) + '" as number, and "' +
          new Date(parseInt(lastRunTime, 10)).toString() + '" as timestamp.' +
            'The query is "' + query + '"'
      });
      return Promise.all([
        lastRunTime,
        gmail.users.messages.list({
          userId: emailAddress,
          q: query
        })
          .then((resultsObj) => {
            logger.debug({ entry: 'resultsObj is ' + JSON.stringify(resultsObj) });
            return resultsObj.messages;
          })
      ]);
    })
    .then((lastRuntime, results) => {
      const filteredFullResults = [];
      let didPush = true;
      for (const result of results) {
        gmail.users.messages.get({
          userId: emailAddress,
          id: result.id
        })
          .then((fullResult) => {
            logger.debug({ entry: 'fullResult is ' + JSON.stringify(fullResult, null, 4) });
            logger.debug({ entry: 'fullResult.internalDate is ' + fullResult.internalDate });
            if (fullResult.internalDate >= lastRuntime) {
              filteredFullResults.push(fullResult);
            } else {
              didPush = false;
            }
          });

        if (didPush === false) {
          break;
        }
      }
      return filteredFullResults;
    })
    .then((filteredFullResults) => {
      logger.debug({ entry: 'filteredFullResults received: ' + JSON.stringify(filteredFullResults, null, 4) });
      if (filteredFullResults.length === 0) {
        logger.info({ entry: 'No emails for "' + emailAddress + '" matching query since we last checked' });
      } else {
        for (const msg of filteredFullResults) {
          const msgResult = sendMessage(msg, emailAddress);
          logger.debug({ entry: 'msgResult: ' + JSON.stringify(msgResult, null, 4) });
        }
        logger.info({ entry: 'Sent ' + filteredFullResults.length + ' notification(s) to ' + emailAddress });
      }
    })
    .catch((err) => {
      // Handle unexpected errors
      logger.error({ entry: 'Caught error: ' + err });
    });
};
