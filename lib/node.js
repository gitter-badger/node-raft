'use strict';

var Log = require('./log');
var Peer = require('./peer');
var async = require('async');
var extend = require('xtend');
var Cluster = require('./cluster');
var inherits = require('util').inherits;
var Broadcast = require('./broadcast');
var LogApplier = require('./log_applier');
var EventEmitter = require('events').EventEmitter;
var defaultOptions = require('./default_node_options');

var states = {
  'idle':      require('./idle'),
  'follower':  require('./follower'),
  'candidate': require('./candidate'),
  'leader':    require('./leader')
};

module.exports = Node;

function Node(options) {
  var self = this;

  if (! (this instanceof Node)) return new Node(options);

  EventEmitter.apply(this);
  this.setMaxListeners(Infinity);

  this.options = extend({}, defaultOptions, options);
  this.id = this.options.id;
  if (! this.id) this.id = this.options.uuid();
  this.cluster = new Cluster(options);
  this.peers = [];
  this.loaded = false;

  this.commonState = {
    volatile: {
      leaderId: undefined,
      commitIndex: 0,
      lastApplied: 0
    },
    persisted: {
      currentTerm: 0,
      votedFor: null,
      log: new Log()
    }
  };

  this.logApplier = new LogApplier(
    this.commonState.persisted.log, this, this.options.persistence);
  this.logApplier.on('applied log', function(logIndex) {
    self.emit('applied log', logIndex);
  });
  this.logApplier.on('error', function(err) {
    self.emit('error', err);
  });

  this.on('election timeout', function() {
    if (this.state) this.state.emit('election timeout');
  });

  this.toState('idle');

  this.load(loaded);

  function loaded(err) {
    self.loaded = true;
    if (err) self.emit(err);
    self.emit('loaded');
    self.toState('follower');
  }
}

inherits(Node, EventEmitter);

var N = Node.prototype;


/// Persistence

N.load = function load(cb) {
  var self = this;

  async.parallel([
    loadMeta,
    loadCommitIndex
    ], done);

  function loadMeta(cb) {
    self.options.persistence.loadMeta(self.id, cb);
  }

  function loadCommitIndex(cb) {
    self.options.persistence.lastAppliedCommitIndex(self.id, cb);
  }

  function done(err, results) {
    if (results) {
      var meta = results[0];
      if (meta) self.commonState.persisted = meta;

      var commitIndex = results[1];
      if (commitIndex) self.commonState.volatile.lastApplied = commitIndex;
    }
    cb(err);
  }
};

N.save = function save(cb) {
  var self = this;

  this.options.persistence.saveMeta(
    this.id, this.commonState.persisted,
    function(err) {
      if (err && ! cb) self.emit('error', err);
      if (cb) cb(err);
    });
};

N.onceLoaded = function onceLoaded(cb) {
  if (this.loaded) cb();
  else this.once('loaded', cb);
};


/// Peers

N.join = function join(peerDesc) {
  var self = this;
  var peer = peerDesc;
  if (! (peerDesc instanceof Peer))
    peer = new Peer(peerDesc, this.options);
  this.peers.push(peer);

  peer.connect();

  peer.on('call', onPeerCall);

  function onPeerCall(type, args, cb) {
    self.onceLoaded(function() {
      var handler = peerCallHandlers[type];
      if (! handler)
        self.emit('error', new Error('unknown peer call type: ' + type));
      else handler.call(self, args, handlerReplied);
    });

    function handlerReplied() {
      var args = arguments;
      self.emit('reply', args);
      self.save(function(err) {
        if (err) self.emit('error', err);
        else cb.apply(null, args);
      });
    }
  }

  peer.on('outgoing call', onPeerOutgoingCall);
  function onPeerOutgoingCall(type, args) {
   self.emit('outgoing call', peer, type, args);
  }

  peer.on('response', onPeerResponse);

  function onPeerResponse(err, args) {
   self.emit('response', peer, err, args);
  }

};

N.toState = function toState(state) {
  var self = this;

  var Ctor = states[state];
  if (! Ctor) throw new Error('Unknown state: ' + state);

  if (self.state) self.state.stop();
  self.emit('state', state, self);
  self.state = new Ctor(self, self.options);
  self.state.on('error', function(err) {
    self.emit('error', err);
  });
  self.emit(state, self);
};

N.broadcast = function broadcast(type, args) {
  return new Broadcast(this, this.peers, type, args);
};

N.isMajority = function isMajority(quorum) {
  var majority = Math.ceil((this.peers.length + 1) / 2); // count self
  return quorum >= majority;
};


/// term

N.currentTerm = function currentTerm(term) {
  if (! term) term = this.commonState.persisted.currentTerm;
  else this.commonState.persisted.currentTerm = term;

  return term;
};


/// Election timeout

N.startElectionTimeout = function startElectionTimeout() {
  this.emit('reset election timeout');
  var self = this;

  this.cancelElectionTimeout();

  this.electionTimeout = setTimeout(function() {
    self.emit('election timeout');
  }, this.randomElectionTimeout());
};

N.cancelElectionTimeout = function cancelElectionTimeout() {
  if (this.electionTimeout) clearTimeout(this.electionTimeout);
};

N.randomElectionTimeout = function randomElectionTimeout() {
  var minElectionTimeout = this.options.minElectionTimeout;
  var maxElectionTimeout = this.options.maxElectionTimeout;

  if (maxElectionTimeout < minElectionTimeout) {
    this.emit('error',
      new Error('maxElectionTimeout is greater than minElectionTimeout'));
   }

  var diff = maxElectionTimeout - minElectionTimeout;
  var d = Math.floor(Math.random() * diff);

  return minElectionTimeout + d;
};


/// Client API

N.command = function command(cmd, cb) {
  var self = this;
  var commitIndex;

  if (this.state.name != 'leader') {
    var err = new Error('not the leader');
    err.code = 'ENOTLEADER';
    err.leader = this.commonState.volatile.leader;
    cb(err);
  }
  else {
    this.commonState.persisted.log.push({
      term: this.currentTerm(),
      command: cmd
    });

    commitIndex = this.commonState.persisted.log.length;
    this.state.replicate(commitIndex, replicateEnded);
  }

  function replicateEnded(err) {
    if (err) {
      if (cb) cb(err);
      else self.emit('error', err);
    } else {
      self.commonState.volatile.commitIndex = commitIndex;
      self.logApplier.maybePersist(persisted);
    }
  }

  function persisted(err) {
    if (err) cb(err);
    else self.save(cb);
  }
};


/// Append AppendEntries

N.onAppendEntries = function onAppendEntries() {
  var self = this;
  var args = arguments;
  self.emit('AppendEntries', args);
  var fn = this.state.onAppendEntries;
  if (fn) fn.apply(this.state, arguments);
  else {
    this.once('state', function() {
      self.onAppendEntries.apply(self, args);
    });
  }
};


/// RequestVote

N.onRequestVote = function onRequestVote() {
  var self = this;
  var args = arguments;
  self.emit('RequestVote', args);
  var fn = this.state.onRequestVote;
  if (fn) fn.apply(this.state, args);
  else {
    this.once('state', function() {
      self.onRequestVote.apply(self, args);
    });
  }
};


var peerCallHandlers = {
  'AppendEntries': N.onAppendEntries,
  'RequestVote': N.onRequestVote
};


/// stop
N.stop = function(cb) {
  if (this.state) {
    this.state.once('stopped', cb);
    this.state.stop();
  } else setImmediate(cb);
};