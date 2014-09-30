'use strict';

var inherits = require('util').inherits;
var EventEmitter = require('events').EventEmitter;

module.exports = Broadcast;

function Broadcast(peers, type, args) {
  var self = this;

  EventEmitter.apply(this);
  peers.forEach(broadcast);

  function broadcast(peer) {
    peer.invoke(type, args, replied);
  }

  function replied() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift('response');
    self.emit(args);
  }
}

inherits(Broadcast, EventEmitter);

var B = Broadcast.prototype;

B.cancel = function cancel() {
  this.removeAllListeners();
};