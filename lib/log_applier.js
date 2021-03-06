'use strict';

module.exports = LogApplier;

var inherits = require('util').inherits;
var EventEmitter = require('events').EventEmitter;

function LogApplier(log, node, persistence) {
  EventEmitter.call(this);

  this.log = log;
  this.node = node;
  this.persistence = persistence;

  this.persisting = false;

  this.maybePersist();
}

inherits(LogApplier, EventEmitter);

var LA = LogApplier.prototype;

LA.maybePersist = function maybePersist(cb) {
  var state = this.node.commonState.volatile;
  if (! this.persisting && state.commitIndex > state.lastApplied) {
    this.persist(cb);
  } else setImmediate(cb);
};

LA.persist = function persist(cb) {
  var self = this;
  var state = self.node.commonState.volatile;

  if (state.commitIndex > state.lastApplied) {
    var lastApplied = state.lastApplied + 1;
    var entry = self.node.commonState.persisted.log[lastApplied - 1];
    self.persistence.applyLog(self.node.id, lastApplied, entry, persisted);
  } else if (cb) setImmediate(cb);

  function persisted(err) {
    self.persisting = false;
    if (err) self.emit('error', err);
    else {
      state.lastApplied = lastApplied;
      self.emit('applied log', lastApplied);
      self.maybePersist(cb);
    }
  }
};