const Entity = require('taskcluster-lib-entities');
const assert = require('assert');
const _ = require('lodash');
const taskcluster = require('taskcluster-client');
const staticScopes = require('./static-scopes.json');

const Client = Entity.configure({
  version: 1,
  partitionKey: Entity.keys.StringKey('clientId'),
  rowKey: Entity.keys.ConstantKey('client'),
  signEntities: true,
  properties: {
    clientId: Entity.types.String,
    description: Entity.types.Text,
    accessToken: Entity.types.EncryptedText,
    expires: Entity.types.Date,
    details: Entity.types.JSON,
  },
}).configure({
  version: 2,
  signEntities: true,
  properties: {
    clientId: Entity.types.String,
    description: Entity.types.Text,
    accessToken: Entity.types.EncryptedText,
    expires: Entity.types.Date,
    /**
     * Details object with properties:
     * - created          // Time when client was created
     * - lastModified     // Last time client was modified
     * - lastDateUsed     // Only updated if more than 6 hours out of date
     * - lastRotated      // Last time accessToken was reset
     * (more properties may be added in the future)
     */
    details: Entity.types.JSON,
    scopes: Entity.types.JSON, // new in v2
    disabled: Entity.types.Number, // new in v2
  },
  migrate(item) {
    item.scopes = [];
    item.disabled = 0;
    return item;
  },
}).configure({
  version: 3,
  signEntities: true,
  properties: {
    clientId: Entity.types.String,
    description: Entity.types.Text,
    accessToken: Entity.types.EncryptedText,
    expires: Entity.types.Date,
    /**
     * Details object with properties:
     * - created            // Time when client was created
     * - lastModified       // Last time client was modified
     * - lastDateUsed       // Only updated if more than 6 hours out of date
     * - lastRotated        // Last time accessToken was reset
     * - deleteOnExpiration // if true, can be deleted after expiration
     *                      // (new in v3)
     * (more properties may be added in the future)
     */
    details: Entity.types.Schema({
      type: 'object',
      properties: {
        created: {type: 'string', format: 'date-time'},
        lastModified: {type: 'string', format: 'date-time'},
        lastDateUsed: {type: 'string', format: 'date-time'},
        lastRotated: {type: 'string', format: 'date-time'},
        deleteOnExpiration: {type: 'boolean'},
      },
      required: [
        'created', 'lastModified', 'lastDateUsed', 'lastRotated',
        'deleteOnExpiration',
      ],
    }),
    scopes: Entity.types.JSON,
    disabled: Entity.types.Number,
  },
  migrate(item) {
    item.details = _.defaults({}, item.details, {deleteOnExpiration: false});
    return item;
  },
});

/** Get scopes granted to this client */
Client.prototype.expandedScopes = function(resolver) {
  return resolver.resolve(this.scopes);
};

/** Get JSON representation of client */
Client.prototype.json = function(resolver) {
  return {
    clientId: this.clientId,
    description: this.description,
    expires: this.expires.toJSON(),
    created: this.details.created,
    lastModified: this.details.lastModified,
    lastDateUsed: this.details.lastDateUsed,
    lastRotated: this.details.lastRotated,
    deleteOnExpiration: this.details.deleteOnExpiration,
    scopes: this.scopes,
    expandedScopes: this.expandedScopes(resolver),
    disabled: !!this.disabled,
  };
};

/**
 * Ensure static clients exist and remove all clients prefixed 'static/', if not
 * in the clients given here.
 *
 * Each client is given by an object:
 *         {clientId, accessToken, description, scopes}
 * , where description will be amended with a section explaining that this
 * client is static and can't be modified at runtime.
 */
Client.syncStaticClients = async function(clients = [], azureAccountId) {
  // Validate input for sanity (we hardly need perfect validation here...)
  assert(clients instanceof Array, 'Expected clients to be am array');
  for (const client of clients) {
    assert(typeof client.clientId === 'string', 'expected clientId to be a string');
    assert(typeof client.accessToken === 'string', 'expected accessToken to be a string');
    assert(client.accessToken.length >= 22, 'accessToken must have at least 22 chars');
    assert(client.accessToken.length <= 66, 'accessToken must have at most 66 chars');
    assert(client.clientId.startsWith('static/'), 'static clients must have clientId = "static/..."');
    if (client.clientId.startsWith('static/taskcluster')) {
      assert(!client.scopes, 'scopes are not allowed in configuration for static/taskcluster clients');
    } else {
      assert(client.scopes instanceof Array, 'expected scopes to be an array of strings');
      assert(typeof client.description === 'string', 'expected description to be a string');
      assert(client.scopes.every(s => typeof s === 'string'), 'scopes must be strings');
    }
  }

  // check that we have all of the expected static/taskcluster clients, and no more.  The staticClients
  // are generated from `services/*/scopes.yml` for all of the other services.
  const seenTCClients = clients
    .map(({clientId}) => clientId)
    .filter(c => c.startsWith('static/taskcluster/'));
  const expectedTCClients = staticScopes
    .map(({clientId}) => clientId);
  const extraTCClients = _.difference(seenTCClients, expectedTCClients);
  const missingTCClients = _.difference(expectedTCClients, seenTCClients);

  if (extraTCClients.length > 0 || missingTCClients.length > 0) {
    let msg = 'Incorrect `static/taskcluster` static clients in STATIC_CLIENTS';
    if (extraTCClients.length > 0) {
      msg = msg + `; extra clients ${JSON.stringify(extraTCClients)}`;
    }
    if (missingTCClients.length > 0) {
      msg = msg + `; missing clients ${JSON.stringify(missingTCClients)}`;
    }
    throw new Error(msg);
  }

  // put the configured scopes into place
  clients = clients.map(client => {
    if (client.clientId.startsWith('static/taskcluster/')) {
      const {scopes} = _.find(staticScopes, {clientId: client.clientId});
      return {...client, description: 'Internal client', scopes};
    } else {
      return client;
    }
  });

  // substitute the azureAccountId into the scopes
  clients = clients.map(client => ({
    ...client,
    scopes: client.scopes.map(sc => sc.replace(/\${azureAccountId}/g, azureAccountId)),
  }));

  // description suffix to use for all static clients
  const descriptionSuffix = [
    '\n---\n',
    'This is a **static client** inserted into this taskcluster deployment',
    'through static configuration. To modify this client you must contact the',
    'administrator who deploys this taskcluster instance.',
  ].join('\n');

  // Scan table to remove/modify entries that are out of date
  const done = []; // list of clientIds we've already synchronized
  await this.scan({}, {handler: async (client) => {
    // Ignore clients that don't start with static/
    if (!client.clientId.startsWith('static/')) {
      return;
    }

    // Find target we should modify the client match
    const target = clients.find(c => c.clientId === client.clientId);
    // If client doesn't exist we delete it
    if (!target) {
      return client.remove(true, true);
    }

    // Ensure that client looks the way it should
    await client.modify(client => {
      client.accessToken = target.accessToken;
      client.scopes = target.scopes;
      client.description = target.description + descriptionSuffix;
    });

    // note that we've sync'ed this clientId
    done.push(client.clientId);
  }});

  // Find clients that we haven't seen yet
  const newClients = clients.filter(c => !done.includes(c.clientId));

  // Create new clients
  await Promise.all(newClients.map(target => {
    return this.create({
      clientId: target.clientId,
      description: target.description + descriptionSuffix,
      accessToken: target.accessToken,
      expires: taskcluster.fromNow('1000 year'),
      scopes: target.scopes,
      disabled: 0,
      details: {
        created: new Date().toJSON(),
        lastModified: new Date().toJSON(),
        lastDateUsed: new Date().toJSON(),
        lastRotated: new Date().toJSON(),
        deleteOnExpiration: false,
      },
    }, true);
  }));
};

/**
 * Delete all clients that expired before `now`, unless
 * details.deleteOnExpiration is false.
 */
Client.purgeExpired = async function(now = new Date()) {
  let count = 0;
  await this.scan({
    expires: Entity.op.lessThan(now),
  }, {
    limit: 100,
    handler: async client => {
      if (client.details.deleteOnExpiration) {
        count++;
        await client.remove(true);
      }
    },
  });

  return count;
};

// Export Client
exports.Client = Client;

const Roles = Entity.configure({
  version: 1,
  partitionKey: Entity.keys.ConstantKey('role'),
  rowKey: Entity.keys.ConstantKey('role'),
  properties: {
    blob: Entity.types.Schema({
      title: 'Roles',
      type: 'array',
      items: {
        type: 'object',
        properties: {
          roleId: {
            type: 'string',
            pattern: '^[\\x20-\\x7e]+$',
          },
          scopes: {
            type: 'array',
            items: {
              type: 'string',
              pattern: '^[\x20-\x7e]*$',
            },
          },
          description: {
            type: 'string',
            maxLength: 1024 * 10,
          },
          lastModified: {
            type: 'string',
            format: 'date-time',
          },
          created: {
            type: 'string',
            format: 'date-time',
          },
        },
        additionalProperties: false,
        required: ['roleId', 'scopes', 'description', 'lastModified', 'created'],
      },
    }),
  },
});

Roles.get = async function() {
  try {
    return (await this.load()).blob;
  } catch (e) {
    if (e.code !== 'ResourceNotFound') {
      throw e;
    }
    return [];
  }
};

/**
 * Update the roles, given a modifier function.  The modification is serialized with
 * any other modifications.  The modifier may be called multiple times.  This function
 * takes care of initializing the set of roles to [] before beginning.
 */
Roles.modifyRole = async function(modifier) {
  try {
    const entry = await this.load();
    await entry.modify(modifier);

  } catch (e) {
    if (e.code !== 'ResourceNotFound') {
      throw e;
    }

    // try to create the blob and update it again
    await this._create();
    return await this.modifyRole(modifier);
  }
};

Roles._create = async function() {
  try {
    // only create if the blob does not already exist..
    return await this.create({ blob: [] });
  } catch (e) {
    if (e.code !== 'EntityAlreadyExists') {
      throw e;
    }
    // fall through - the blob exists, which is what we wanted
  }
};

// Export Roles
exports.Roles = Roles;
