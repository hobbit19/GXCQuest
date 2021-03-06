var fs = require('fs'),
    config = require('../config.json'),
    MySQL = require('./database/mysql'),
    WebSocket = require('./network/websocket'),
    _ = require('underscore'),
    allowConnections = false,
    Parser = require('./util/parser'),
    ShutdownHook = require('shutdown-hook'),
    Log = require('log'),
    worlds = [], database,
    Bot = require('../../tools/bot/bot'),
    axios = require('axios'),
    hash = require('object-hash'),
    GXC = require('./util/gxc');

var worldsCreated = 0;

log = new Log(config.worlds > 1 ? 'notice' : config.debugLevel, config.localDebug ? fs.createWriteStream('runtime.log') : null);

function Main() {

    log.notice('Initializing ' + config.name + ' game engine...');

    var shutdownHook = new ShutdownHook(),
        stdin = process.openStdin(),
        World = require('./game/world'),
        webSocket = new WebSocket.Server(config.host, config.port, config.gver);

    if (!config.offlineMode)
        database = new MySQL(config.mysqlHost, config.mysqlPort, config.mysqlUser, config.mysqlPassword, config.mysqlDatabase);

    webSocket.onOAuth(function (code, res) {
        let gxcData = null;
        let accessToken = null;
        const tokenURL = `${config.gxc.server.url}${config.gxc.server.oauth.tokenURL}`;
        const tokenParams = { 
            client_id: config.gxc.client.id,
            client_secret: config.gxc.client.secret,
            code,
            grant_type: config.gxc.client.grantType
        };
        const meURL = `${config.gxc.server.url}${config.gxc.server.oauth.meURL}`;
        return axios.post(tokenURL, tokenParams)
            .then(function (response) {
                accessToken = response.data.access_token.token;
                const meParams = {
                    headers: { Authorization: `Bearer ${accessToken}` }
                };
                return axios.get(meURL, meParams);
            })
            .then(function (response) {
                gxcData = response.data;
                const data = {
                    selector: ['username', 'gqtToken'],
                    params: { username: gxcData.account }
                };
                const player = {
                    username: gxcData.account,
                    email: gxcData.email,
                    password: gxcData.id
                };
                const accessData = {
                    username: gxcData.account,
                    accessToken,
                    accessTime: new Date()
                };
                GXC.getBalance(gxcData.account, function (response) {
                    database.selectData('player_wallet', data, function(error, rows, fields) {
                        if (error) {
                            throw error;
                        } else {
                            const balance = parseInt(response.data.balance || 0);
                            accessData.gqtToken = balance;
                            var type = 'INSERT INTO';
                            if (rows.length > 0) {
                                type = 'UPDATE IGNORE';
                                var info = rows.shift();
                                if (balance !== info.gqtToken) {
                                    console.error('balance not matching to wallet');
                                }
                            }
                            database.queryData(type, 'player_wallet', accessData);
                        }
                    });
                })
            })
            .then(function () {
                const tempKey = hash(gxcData.id);
                res.writeHead(200);
                res.end(`<html><script>window.opener.gxcLoginHander('${gxcData.id}','${tempKey}');</script></html>`);
            })
            .catch(function(error) {
                console.error(error);
            });
    })
    webSocket.onConnect(function(connection) {
        if (!allowConnections) {
            connection.sendUTF8('disallowed');
            connection.close();
        }

        var world;

        for (var i = 0; i < worlds.length; i++) {
            if (worlds[i].playerCount < worlds[i].maxPlayers) {
                world = worlds[i];
                break;
            }
        }

        if (world)
            world.playerConnectCallback(connection);
        else {
            log.info('Worlds are currently full, closing...');

            connection.sendUTF8('full');
            connection.close();
        }

    });

    setTimeout(function() {

        loadParser();

        for (var i = 0; i < config.worlds; i++)
            worlds.push(new World(i + 1, webSocket, database));

        initializeWorlds();

    }, 200);

    /**
     * We want to generate worlds after the socket
     * has finished initializing.
     */

    process.on('SIGINT', function() {
        shutdownHook.register();
    });

    process.on('SIGQUIT', function() {
        shutdownHook.register();
    });

    shutdownHook.on('ShutdownStarted', function() {
        saveAll();
    });

    stdin.addListener('data', function(data) {
        /**
         * We have to cleanse the raw message because of the \n
         */

        var message = data.toString().replace(/(\r\n|\n|\r)/gm, ''),
            type = message.charAt(0);

        if (type !== '/')
            return;

        var blocks = message.substring(1).split(' '),
            command = blocks.shift();

        if (!command)
            return;

        switch (command) {

            case 'stop':

                log.info('Safely shutting down the server...');

                saveAll();

                process.exit();

                break;

            case 'saveall':

                saveAll();

                break;

            case 'alter':

                if (blocks.length !== 3) {
                    log.error('Invalid command format. /alter [database] [table] [type]');
                    return;
                }

                if (!database) {
                    log.error('The database server is not available for this instance of ' + config.name + '.');
                    log.error('Ensure that the database is enabled in the server configuration.');
                    return;
                }

                var db = blocks.shift(),
                    table = blocks.shift(),
                    dType = blocks.shift();

                database.alter(db, table, dType);

                break;

            case 'bot':

                var count = parseInt(blocks.shift());

                if (!count)
                    count = 1;

                new Bot(worlds[0], count);

                break;

        }

    });

}


function onWorldLoad() {
    worldsCreated++;
    if (worldsCreated === worlds.length)
        allWorldsCreated();
}

function allWorldsCreated() {
    log.notice('Finished creating ' + worlds.length + ' world' + (worlds.length > 1 ? 's' : '') + '!');
    allowConnections = true;

    var host = config.host === '0.0.0.0' ? 'localhost' : config.host;
    log.notice('Connect locally via http://' + host + ':' + config.port);
}

function loadParser() {
    new Parser();
}

function initializeWorlds() {
    for (var worldId in worlds)
        if (worlds.hasOwnProperty(worldId))
            worlds[worldId].load(onWorldLoad);
}

function getPopulations() {
    var counts = [];

    for (var index in worlds)
        if (worlds.hasOwnProperty(index))
            counts.push(worlds[index].getPopulation());

    return counts;
}

function saveAll() {
    _.each(worlds, function(world) {
        world.saveAll();
    });

    var plural = worlds.length > 1;

    log.notice('Saved players for ' + worlds.length + ' world' + (plural ? 's' : '') + '.');
}

if ( typeof String.prototype.startsWith !== 'function' ) {
    String.prototype.startsWith = function( str ) {
        return str.length > 0 && this.substring( 0, str.length ) === str;
    };
}

if ( typeof String.prototype.endsWith !== 'function' ) {
    String.prototype.endsWith = function( str ) {
        return str.length > 0 && this.substring( this.length - str.length, this.length ) === str;
    };
}

new Main();
