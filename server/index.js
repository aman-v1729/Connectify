//////////////////////////////////////////////////////////////////////////
// Configuration                                                        //
//////////////////////////////////////////////////////////////////////////

// express
var express = require('express');
var app = express();

require('dotenv').config();

// socket.io
var http = require('http').Server(app);
var io = require('socket.io')(http);

// lodash
var lodash = require('lodash');

// request logging
var morgan = require('morgan')
app.use(morgan('short'));

// turn off unnecessary header
app.disable('x-powered-by');

// turn on strict routing
app.enable('strict routing');

// use the X-Forwarded-* headers
app.enable('trust proxy');

// add CORS headers
app.use(function (req, res, next) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.setHeader('Access-Control-Allow-Credentials', true);
    next();
});

//////////////////////////////////////////////////////////////////////////
// State                                                                //
//////////////////////////////////////////////////////////////////////////

// in-memory store of all the sessions
// the keys are the session IDs (strings)
// the values have the form: {
//   id: 'cba82ca5f59a35e6',                                                                // 8 random octets
//   lastKnownTime: 123,                                                                    // milliseconds from the start of the video
//   lastKnownTimeUpdatedAt: new Date(),                                                    // when we last received a time update
//   messages: [{ userId: '3d16d961f67e9792', body: 'hello', timestamp: new Date() }, ...], // the chat messages for this session
//   ownerId: '3d16d961f67e9792',                                                           // id of the session owner (if any)
//   state: 'playing' | 'paused',                                                           // whether the video is playing or paused
//   userIds: ['3d16d961f67e9792', ...],                                                    // ids of the users in the session
//   videoId: 'abc123',                                                                         // Netflix id the video
//   host: 'www.{youtube|netflix|hotstar}.com'                                              // location.host
// }
var sessions = {};
// const SupportedHosts = ['www.youtube.com','www.netflix.com','www.hotstar.com'];

// in-memory store of all the users
// the keys are the user IDs (strings)
// the values have the form: {
//   id: '3d16d961f67e9792',        // 8 random octets
//   sessionId: 'cba82ca5f59a35e6', // id of the session, if one is joined
//   socket: <websocket>,           // the websocket
//   typing: false                  // whether the user is typing or not
// }
var users = {};

// generate a random ID with 64 bits of entropy
function makeId() {
    var result = '';
    var hexChars = '0123456789abcdef';
    for (var i = 0; i < 16; i += 1) {
        result += hexChars[Math.floor(Math.random() * 16)];
    }
    return result;
}

//////////////////////////////////////////////////////////////////////////
// Web endpoints                                                        //
//////////////////////////////////////////////////////////////////////////

// health check
app.get('/', function (req, res) {
    console.log(req.query);
    res.setHeader('Content-Type', 'text/plain');
    res.send('OK');
});

// number of sessions
app.get('/number-of-sessions', function (req, res) {
    res.setHeader('Content-Type', 'text/plain');
    res.send(String(Object.keys(sessions).length));
});

// number of users
app.get('/number-of-users', function (req, res) {
    res.setHeader('Content-Type', 'text/plain');
    res.send(String(Object.keys(users).length));
});

app.get('/session-details', function (req, res) {
    res.setHeader('Content-Type', 'application/json')
    res.send(JSON.stringify(sessions))
});

app.get('/reset', function (req, res) {
    sessions = {};
    users = {};
    res.status(200).send()
})


//////////////////////////////////////////////////////////////////////////
// Websockets API                                                       //
//////////////////////////////////////////////////////////////////////////

function validateId(id) {
    return typeof id === 'string' && id.length === 16;
}

function validateLastKnownTime(lastKnownTime) {
    return typeof lastKnownTime === 'number' &&
        lastKnownTime % 1 === 0 &&
        lastKnownTime >= 0;
}

function validateTimestamp(timestamp) {
    return typeof timestamp === 'number' &&
        timestamp % 1 === 0 &&
        timestamp >= 0;
}

function validateBoolean(boolean) {
    return typeof boolean === 'boolean';
}

function validateMessages(messages) {
    if (typeof messages !== 'object' || messages === null || typeof messages.length !== 'number') {
        return false;
    }
    for (var i in messages) {
        if (messages.hasOwnProperty(i)) {
            i = parseInt(i);
            if (isNaN(i)) {
                return false;
            }
            if (typeof i !== 'number' || i % 1 !== 0 || i < 0 || i >= messages.length) {
                return false;
            }
            if (typeof messages[i] !== 'object' || messages[i] === null) {
                return false;
            }
            if (!validateMessageBody(messages[i].body)) {
                return false;
            }
            if (messages[i].isSystemMessage === undefined) {
                messages[i].isSystemMessage = false;
            }
            if (!validateBoolean(messages[i].isSystemMessage)) {
                return false;
            }
            if (!validateTimestamp(messages[i].timestamp)) {
                return false;
            }
            if (!validateId(messages[i].userId)) {
                return false;
            }
        }
    }
    return true;
}

function validateState(state) {
    return typeof state === 'string' && (state === 'playing' || state === 'paused');
}


function validateMessageBody(body) {
    return typeof body === 'string' && body.replace(/^\s+|\s+$/g, '') !== '';
}

function padIntegerWithZeros(x, minWidth) {
    var numStr = String(x);
    while (numStr.length < minWidth) {
        numStr = '0' + numStr;
    }
    return numStr;
}

//---------------------------------------------------------------
//---------------------------------------------------------------
//---------------------------------------------------------------
//---------------------------------------------------------------
//---------------------------------------------------------------
//---------------------------------------------------------------
//---------------------------------------------------------------
//---------------------------------------------------------------
//---------------------------------------------------------------



io.on('connection', function (socket) {
    var userId = makeId();
    while (users.hasOwnProperty(userId)) {
        userId = makeId();
    }
    users[userId] = {
        id: userId,
        username: "guest" + userId,
        sessionId: null,
        socket: socket,
        typing: false
    };
    socket.emit('userId', userId);
    console.log('User ' + userId + ' connected.');

    // precondition: sessionId is the id of a session
    // precondition: notToThisUserId is the id of a user, or null
    var broadcastPresence = function (sessionId, notToThisUserId) {
        var anyoneTyping = false;
        for (var i = 0; i < sessions[sessionId].userIds.length; i += 1) {
            if (users[sessions[sessionId].userIds[i]].typing) {
                anyoneTyping = true;
                break;
            }
        }

        lodash.forEach(sessions[sessionId].userIds, function (id) {
            if (id !== notToThisUserId) {
                console.log('Sending presence to user ' + id + '.');
                users[id].socket.emit('setPresence', {
                    anyoneTyping: anyoneTyping
                });
            }
        });
    };

    // precondition: user userId is in a session
    // precondition: body is a string
    // precondition: isSystemMessage is a boolean
    var sendMessage = function (body, isSystemMessage) {
        var message = {
            body: body,
            isSystemMessage: isSystemMessage,
            timestamp: new Date(),
            userId: userId
        };
        sessions[users[userId].sessionId].messages.push(message);

        lodash.forEach(sessions[users[userId].sessionId].userIds, function (id) {
            console.log('Sending message to user ' + id + '.');
            users[id].socket.emit('sendMessage', {
                body: message.body,
                isSystemMessage: isSystemMessage,
                timestamp: message.timestamp.getTime(),
                userId: message.userId
            });
        });
    };

    // precondition: user userId is in a session
    const leaveSession = (broadcast) => {
        sendMessage('left', true);

        var sessionId = users[userId].sessionId;
        lodash.pull(sessions[sessionId].userIds, userId);
        users[userId].sessionId = null;

        if (sessions[sessionId].userIds.length === 0) {
            delete sessions[sessionId];
            console.log('Session ' + sessionId + ' was deleted because there were no more users in it.');
        } else {
            if (broadcast) {
                broadcastPresence(sessionId, null);
            }
        }
    };


    socket.on('join', (url, fn) => {
        var sessionId = url;

        // Validation Checks
        if (!users.hasOwnProperty(userId)) {
            fn({ errorMessage: 'Disconnected.' });
            console.log('The socket received a message after it was disconnected.');
            return;
        }

        if (users[userId].sessionId !== null) {
            fn({ errorMessage: 'Already in a session.' });
            console.log('User ' + userId + ' attempted to join session ' + sessionId + ', but the user is already in session ' + users[userId].sessionId + '.');
            return;
        }


        if (sessions.hasOwnProperty(sessionId)) {
            users[userId].sessionId = sessionId;
            sessions[sessionId].userIds.push(userId);
            sendMessage('joined', true);

            fn({
                messages: lodash.map(sessions[sessionId].messages, function (message) {
                    return {
                        body: message.body,
                        isSystemMessage: message.isSystemMessage,
                        timestamp: message.timestamp.getTime(),
                        userId: message.userId
                    };
                }),
                ownerId: sessions[sessionId].ownerId,
                state: sessions[sessionId].state
            });
        }
        else {
            var session = {
                id: sessionId,
                messages: [],
                userIds: [userId],
            };
            users[userId].sessionId = sessionId;
            sessions[session.id] = session;
            fn({
                messages: lodash.map(sessions[users[userId].sessionId].messages, function (message) {
                    return {
                        body: message.body,
                        isSystemMessage: message.isSystemMessage,
                        timestamp: message.timestamp.getTime(),
                        userId: message.userId
                    };
                }),
                sessionId: users[userId].sessionId,
                state: sessions[users[userId].sessionId].state
            });

        }
        //sendMessage('Joined!');
        console.log('User ' + userId + ' joined session ' + sessionId + '.');
    });

    socket.on('leaveSession', (_, fn) => {
        if (!users.hasOwnProperty(userId)) {
            fn({ errorMessage: 'Disconnected.' });
            console.log('The socket received a message after it was disconnected.');
            return;
        }

        if (users[userId].sessionId === null) {
            fn({ errorMessage: 'Not in a session.' });
            console.log('User ' + userId + ' attempted to leave a session, but the user was not in one.');
            return;
        }

        var sessionId = users[userId].sessionId;
        leaveSession(true);

        fn(null);
        console.log('User ' + userId + ' left session ' + sessionId + '.');
    });


    socket.on('typing', function (data, fn) {
        if (!users.hasOwnProperty(userId)) {
            fn({ errorMessage: 'Disconnected.' });
            console.log('The socket received a message after it was disconnected.');
            return;
        }

        if (users[userId].sessionId === null) {
            fn({ errorMessage: 'Not in a session.' });
            console.log('User ' + userId + ' attempted to set presence, but the user was not in a session.');
            return;
        }

        if (!validateBoolean(data.typing)) {
            fn({ errorMessage: 'Invalid typing.' });
            console.log('User ' + userId + ' attempted to set invalid presence ' + JSON.stringify(data.typing) + '.');
            return;
        }

        users[userId].typing = data.typing;

        fn();
        if (users[userId].typing) {
            console.log('User ' + userId + ' is typing...');
        } else {
            console.log('User ' + userId + ' is done typing.');
        }

        broadcastPresence(users[userId].sessionId, userId);
    });

    socket.on('sendMessage', function (data, fn) {
        if (!users.hasOwnProperty(userId)) {
            fn({ errorMessage: 'Disconnected.' });
            console.log('The socket received a message after it was disconnected.');
            return;
        }

        if (users[userId].sessionId === null) {
            fn({ errorMessage: 'Not in a session.' });
            console.log('User ' + userId + ' attempted to send a message, but the user was not in a session.');
            return;
        }

        if (!validateMessageBody(data.body)) {
            fn({ errorMessage: 'Invalid message body.' });
            console.log('User ' + userId + ' attempted to send an invalid message ' + JSON.stringify(data.body) + '.');
            return;
        }

        sendMessage(data.body, false);

        fn();
        console.log('User ' + userId + ' sent message ' + data.body + '.');
    });

    socket.on('disconnect', function () {
        if (!users.hasOwnProperty(userId)) {
            console.log('The socket received a message after it was disconnected.');
            return;
        }

        if (users[userId].sessionId !== null) {
            leaveSession(true);
        }
        delete users[userId];
        console.log('User ' + userId + ' disconnected.');
    });
});

const port = process.env.PORT;

var server = http.listen(port || 5000, function () {
    console.log('Listening on port %d.', server.address().port);
});
