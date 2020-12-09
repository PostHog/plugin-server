/*eslint-disable block-scoped-var, id-length, no-control-regex, no-magic-numbers, no-prototype-builtins, no-redeclare, no-shadow, no-var, sort-vars*/
'use strict'

var $protobuf = require('protobufjs/minimal')

// Common aliases
var $Reader = $protobuf.Reader,
    $Writer = $protobuf.Writer,
    $util = $protobuf.util

// Exported root namespace
var $root = $protobuf.roots['default'] || ($protobuf.roots['default'] = {})

$root.Event = (function () {
    /**
     * Properties of an Event.
     * @exports IEvent
     * @interface IEvent
     * @property {string|null} [uuid] Event uuid
     * @property {string|null} [event] Event event
     * @property {string|null} [properties] Event properties
     * @property {string|null} [timestamp] Event timestamp
     * @property {number|Long|null} [teamId] Event teamId
     * @property {string|null} [distinctId] Event distinctId
     * @property {string|null} [createdAt] Event createdAt
     * @property {string|null} [elementsChain] Event elementsChain
     * @property {google.protobuf.ITimestamp|null} [protoCreatedAt] Event protoCreatedAt
     * @property {google.protobuf.ITimestamp|null} [protoTimestamp] Event protoTimestamp
     */

    /**
     * Constructs a new Event.
     * @exports Event
     * @classdesc Represents an Event.
     * @implements IEvent
     * @constructor
     * @param {IEvent=} [properties] Properties to set
     */
    function Event(properties) {
        if (properties) {
            for (var keys = Object.keys(properties), i = 0; i < keys.length; ++i) {
                if (properties[keys[i]] != null) {
                    this[keys[i]] = properties[keys[i]]
                }
            }
        }
    }

    /**
     * Event uuid.
     * @member {string} uuid
     * @memberof Event
     * @instance
     */
    Event.prototype.uuid = ''

    /**
     * Event event.
     * @member {string} event
     * @memberof Event
     * @instance
     */
    Event.prototype.event = ''

    /**
     * Event properties.
     * @member {string} properties
     * @memberof Event
     * @instance
     */
    Event.prototype.properties = ''

    /**
     * Event timestamp.
     * @member {string} timestamp
     * @memberof Event
     * @instance
     */
    Event.prototype.timestamp = ''

    /**
     * Event teamId.
     * @member {number|Long} teamId
     * @memberof Event
     * @instance
     */
    Event.prototype.teamId = $util.Long ? $util.Long.fromBits(0, 0, true) : 0

    /**
     * Event distinctId.
     * @member {string} distinctId
     * @memberof Event
     * @instance
     */
    Event.prototype.distinctId = ''

    /**
     * Event createdAt.
     * @member {string} createdAt
     * @memberof Event
     * @instance
     */
    Event.prototype.createdAt = ''

    /**
     * Event elementsChain.
     * @member {string} elementsChain
     * @memberof Event
     * @instance
     */
    Event.prototype.elementsChain = ''

    /**
     * Event protoCreatedAt.
     * @member {google.protobuf.ITimestamp|null|undefined} protoCreatedAt
     * @memberof Event
     * @instance
     */
    Event.prototype.protoCreatedAt = null

    /**
     * Event protoTimestamp.
     * @member {google.protobuf.ITimestamp|null|undefined} protoTimestamp
     * @memberof Event
     * @instance
     */
    Event.prototype.protoTimestamp = null

    /**
     * Creates a new Event instance using the specified properties.
     * @function create
     * @memberof Event
     * @static
     * @param {IEvent=} [properties] Properties to set
     * @returns {Event} Event instance
     */
    Event.create = function create(properties) {
        return new Event(properties)
    }

    /**
     * Encodes the specified Event message. Does not implicitly {@link Event.verify|verify} messages.
     * @function encode
     * @memberof Event
     * @static
     * @param {IEvent} message Event message or plain object to encode
     * @param {$protobuf.Writer} [writer] Writer to encode to
     * @returns {$protobuf.Writer} Writer
     */
    Event.encode = function encode(message, writer) {
        if (!writer) {
            writer = $Writer.create()
        }
        if (message.uuid != null && Object.hasOwnProperty.call(message, 'uuid')) {
            writer.uint32(/* id 1, wireType 2 =*/ 10).string(message.uuid)
        }
        if (message.event != null && Object.hasOwnProperty.call(message, 'event')) {
            writer.uint32(/* id 2, wireType 2 =*/ 18).string(message.event)
        }
        if (message.properties != null && Object.hasOwnProperty.call(message, 'properties')) {
            writer.uint32(/* id 3, wireType 2 =*/ 26).string(message.properties)
        }
        if (message.timestamp != null && Object.hasOwnProperty.call(message, 'timestamp')) {
            writer.uint32(/* id 4, wireType 2 =*/ 34).string(message.timestamp)
        }
        if (message.teamId != null && Object.hasOwnProperty.call(message, 'teamId')) {
            writer.uint32(/* id 5, wireType 0 =*/ 40).uint64(message.teamId)
        }
        if (message.distinctId != null && Object.hasOwnProperty.call(message, 'distinctId')) {
            writer.uint32(/* id 6, wireType 2 =*/ 50).string(message.distinctId)
        }
        if (message.createdAt != null && Object.hasOwnProperty.call(message, 'createdAt')) {
            writer.uint32(/* id 7, wireType 2 =*/ 58).string(message.createdAt)
        }
        if (message.elementsChain != null && Object.hasOwnProperty.call(message, 'elementsChain')) {
            writer.uint32(/* id 8, wireType 2 =*/ 66).string(message.elementsChain)
        }
        if (message.protoCreatedAt != null && Object.hasOwnProperty.call(message, 'protoCreatedAt')) {
            $root.google.protobuf.Timestamp.encode(
                message.protoCreatedAt,
                writer.uint32(/* id 9, wireType 2 =*/ 74).fork()
            ).ldelim()
        }
        if (message.protoTimestamp != null && Object.hasOwnProperty.call(message, 'protoTimestamp')) {
            $root.google.protobuf.Timestamp.encode(
                message.protoTimestamp,
                writer.uint32(/* id 10, wireType 2 =*/ 82).fork()
            ).ldelim()
        }
        return writer
    }

    /**
     * Encodes the specified Event message, length delimited. Does not implicitly {@link Event.verify|verify} messages.
     * @function encodeDelimited
     * @memberof Event
     * @static
     * @param {IEvent} message Event message or plain object to encode
     * @param {$protobuf.Writer} [writer] Writer to encode to
     * @returns {$protobuf.Writer} Writer
     */
    Event.encodeDelimited = function encodeDelimited(message, writer) {
        return this.encode(message, writer).ldelim()
    }

    /**
     * Decodes an Event message from the specified reader or buffer.
     * @function decode
     * @memberof Event
     * @static
     * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
     * @param {number} [length] Message length if known beforehand
     * @returns {Event} Event
     * @throws {Error} If the payload is not a reader or valid buffer
     * @throws {$protobuf.util.ProtocolError} If required fields are missing
     */
    Event.decode = function decode(reader, length) {
        if (!(reader instanceof $Reader)) {
            reader = $Reader.create(reader)
        }
        var end = length === undefined ? reader.len : reader.pos + length,
            message = new $root.Event()
        while (reader.pos < end) {
            var tag = reader.uint32()
            switch (tag >>> 3) {
                case 1:
                    message.uuid = reader.string()
                    break
                case 2:
                    message.event = reader.string()
                    break
                case 3:
                    message.properties = reader.string()
                    break
                case 4:
                    message.timestamp = reader.string()
                    break
                case 5:
                    message.teamId = reader.uint64()
                    break
                case 6:
                    message.distinctId = reader.string()
                    break
                case 7:
                    message.createdAt = reader.string()
                    break
                case 8:
                    message.elementsChain = reader.string()
                    break
                case 9:
                    message.protoCreatedAt = $root.google.protobuf.Timestamp.decode(reader, reader.uint32())
                    break
                case 10:
                    message.protoTimestamp = $root.google.protobuf.Timestamp.decode(reader, reader.uint32())
                    break
                default:
                    reader.skipType(tag & 7)
                    break
            }
        }
        return message
    }

    /**
     * Decodes an Event message from the specified reader or buffer, length delimited.
     * @function decodeDelimited
     * @memberof Event
     * @static
     * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
     * @returns {Event} Event
     * @throws {Error} If the payload is not a reader or valid buffer
     * @throws {$protobuf.util.ProtocolError} If required fields are missing
     */
    Event.decodeDelimited = function decodeDelimited(reader) {
        if (!(reader instanceof $Reader)) {
            reader = new $Reader(reader)
        }
        return this.decode(reader, reader.uint32())
    }

    /**
     * Verifies an Event message.
     * @function verify
     * @memberof Event
     * @static
     * @param {Object.<string,*>} message Plain object to verify
     * @returns {string|null} `null` if valid, otherwise the reason why it is not
     */
    Event.verify = function verify(message) {
        if (typeof message !== 'object' || message === null) {
            return 'object expected'
        }
        if (message.uuid != null && message.hasOwnProperty('uuid')) {
            if (!$util.isString(message.uuid)) {
                return 'uuid: string expected'
            }
        }
        if (message.event != null && message.hasOwnProperty('event')) {
            if (!$util.isString(message.event)) {
                return 'event: string expected'
            }
        }
        if (message.properties != null && message.hasOwnProperty('properties')) {
            if (!$util.isString(message.properties)) {
                return 'properties: string expected'
            }
        }
        if (message.timestamp != null && message.hasOwnProperty('timestamp')) {
            if (!$util.isString(message.timestamp)) {
                return 'timestamp: string expected'
            }
        }
        if (message.teamId != null && message.hasOwnProperty('teamId')) {
            if (
                !$util.isInteger(message.teamId) &&
                !(message.teamId && $util.isInteger(message.teamId.low) && $util.isInteger(message.teamId.high))
            ) {
                return 'teamId: integer|Long expected'
            }
        }
        if (message.distinctId != null && message.hasOwnProperty('distinctId')) {
            if (!$util.isString(message.distinctId)) {
                return 'distinctId: string expected'
            }
        }
        if (message.createdAt != null && message.hasOwnProperty('createdAt')) {
            if (!$util.isString(message.createdAt)) {
                return 'createdAt: string expected'
            }
        }
        if (message.elementsChain != null && message.hasOwnProperty('elementsChain')) {
            if (!$util.isString(message.elementsChain)) {
                return 'elementsChain: string expected'
            }
        }
        if (message.protoCreatedAt != null && message.hasOwnProperty('protoCreatedAt')) {
            var error = $root.google.protobuf.Timestamp.verify(message.protoCreatedAt)
            if (error) {
                return 'protoCreatedAt.' + error
            }
        }
        if (message.protoTimestamp != null && message.hasOwnProperty('protoTimestamp')) {
            var error = $root.google.protobuf.Timestamp.verify(message.protoTimestamp)
            if (error) {
                return 'protoTimestamp.' + error
            }
        }
        return null
    }

    /**
     * Creates an Event message from a plain object. Also converts values to their respective internal types.
     * @function fromObject
     * @memberof Event
     * @static
     * @param {Object.<string,*>} object Plain object
     * @returns {Event} Event
     */
    Event.fromObject = function fromObject(object) {
        if (object instanceof $root.Event) {
            return object
        }
        var message = new $root.Event()
        if (object.uuid != null) {
            message.uuid = String(object.uuid)
        }
        if (object.event != null) {
            message.event = String(object.event)
        }
        if (object.properties != null) {
            message.properties = String(object.properties)
        }
        if (object.timestamp != null) {
            message.timestamp = String(object.timestamp)
        }
        if (object.teamId != null) {
            if ($util.Long) {
                ;(message.teamId = $util.Long.fromValue(object.teamId)).unsigned = true
            } else if (typeof object.teamId === 'string') {
                message.teamId = parseInt(object.teamId, 10)
            } else if (typeof object.teamId === 'number') {
                message.teamId = object.teamId
            } else if (typeof object.teamId === 'object') {
                message.teamId = new $util.LongBits(object.teamId.low >>> 0, object.teamId.high >>> 0).toNumber(true)
            }
        }
        if (object.distinctId != null) {
            message.distinctId = String(object.distinctId)
        }
        if (object.createdAt != null) {
            message.createdAt = String(object.createdAt)
        }
        if (object.elementsChain != null) {
            message.elementsChain = String(object.elementsChain)
        }
        if (object.protoCreatedAt != null) {
            if (typeof object.protoCreatedAt !== 'object') {
                throw TypeError('.Event.protoCreatedAt: object expected')
            }
            message.protoCreatedAt = $root.google.protobuf.Timestamp.fromObject(object.protoCreatedAt)
        }
        if (object.protoTimestamp != null) {
            if (typeof object.protoTimestamp !== 'object') {
                throw TypeError('.Event.protoTimestamp: object expected')
            }
            message.protoTimestamp = $root.google.protobuf.Timestamp.fromObject(object.protoTimestamp)
        }
        return message
    }

    /**
     * Creates a plain object from an Event message. Also converts values to other types if specified.
     * @function toObject
     * @memberof Event
     * @static
     * @param {Event} message Event
     * @param {$protobuf.IConversionOptions} [options] Conversion options
     * @returns {Object.<string,*>} Plain object
     */
    Event.toObject = function toObject(message, options) {
        if (!options) {
            options = {}
        }
        var object = {}
        if (options.defaults) {
            object.uuid = ''
            object.event = ''
            object.properties = ''
            object.timestamp = ''
            if ($util.Long) {
                var long = new $util.Long(0, 0, true)
                object.teamId =
                    options.longs === String ? long.toString() : options.longs === Number ? long.toNumber() : long
            } else {
                object.teamId = options.longs === String ? '0' : 0
            }
            object.distinctId = ''
            object.createdAt = ''
            object.elementsChain = ''
            object.protoCreatedAt = null
            object.protoTimestamp = null
        }
        if (message.uuid != null && message.hasOwnProperty('uuid')) {
            object.uuid = message.uuid
        }
        if (message.event != null && message.hasOwnProperty('event')) {
            object.event = message.event
        }
        if (message.properties != null && message.hasOwnProperty('properties')) {
            object.properties = message.properties
        }
        if (message.timestamp != null && message.hasOwnProperty('timestamp')) {
            object.timestamp = message.timestamp
        }
        if (message.teamId != null && message.hasOwnProperty('teamId')) {
            if (typeof message.teamId === 'number') {
                object.teamId = options.longs === String ? String(message.teamId) : message.teamId
            } else {
                object.teamId =
                    options.longs === String
                        ? $util.Long.prototype.toString.call(message.teamId)
                        : options.longs === Number
                        ? new $util.LongBits(message.teamId.low >>> 0, message.teamId.high >>> 0).toNumber(true)
                        : message.teamId
            }
        }
        if (message.distinctId != null && message.hasOwnProperty('distinctId')) {
            object.distinctId = message.distinctId
        }
        if (message.createdAt != null && message.hasOwnProperty('createdAt')) {
            object.createdAt = message.createdAt
        }
        if (message.elementsChain != null && message.hasOwnProperty('elementsChain')) {
            object.elementsChain = message.elementsChain
        }
        if (message.protoCreatedAt != null && message.hasOwnProperty('protoCreatedAt')) {
            object.protoCreatedAt = $root.google.protobuf.Timestamp.toObject(message.protoCreatedAt, options)
        }
        if (message.protoTimestamp != null && message.hasOwnProperty('protoTimestamp')) {
            object.protoTimestamp = $root.google.protobuf.Timestamp.toObject(message.protoTimestamp, options)
        }
        return object
    }

    /**
     * Converts this Event to JSON.
     * @function toJSON
     * @memberof Event
     * @instance
     * @returns {Object.<string,*>} JSON object
     */
    Event.prototype.toJSON = function toJSON() {
        return this.constructor.toObject(this, $protobuf.util.toJSONOptions)
    }

    return Event
})()

$root.google = (function () {
    /**
     * Namespace google.
     * @exports google
     * @namespace
     */
    var google = {}

    google.protobuf = (function () {
        /**
         * Namespace protobuf.
         * @memberof google
         * @namespace
         */
        var protobuf = {}

        protobuf.Timestamp = (function () {
            /**
             * Properties of a Timestamp.
             * @memberof google.protobuf
             * @interface ITimestamp
             * @property {number|Long|null} [seconds] Timestamp seconds
             * @property {number|null} [nanos] Timestamp nanos
             */

            /**
             * Constructs a new Timestamp.
             * @memberof google.protobuf
             * @classdesc Represents a Timestamp.
             * @implements ITimestamp
             * @constructor
             * @param {google.protobuf.ITimestamp=} [properties] Properties to set
             */
            function Timestamp(properties) {
                if (properties) {
                    for (var keys = Object.keys(properties), i = 0; i < keys.length; ++i) {
                        if (properties[keys[i]] != null) {
                            this[keys[i]] = properties[keys[i]]
                        }
                    }
                }
            }

            /**
             * Timestamp seconds.
             * @member {number|Long} seconds
             * @memberof google.protobuf.Timestamp
             * @instance
             */
            Timestamp.prototype.seconds = $util.Long ? $util.Long.fromBits(0, 0, false) : 0

            /**
             * Timestamp nanos.
             * @member {number} nanos
             * @memberof google.protobuf.Timestamp
             * @instance
             */
            Timestamp.prototype.nanos = 0

            /**
             * Creates a new Timestamp instance using the specified properties.
             * @function create
             * @memberof google.protobuf.Timestamp
             * @static
             * @param {google.protobuf.ITimestamp=} [properties] Properties to set
             * @returns {google.protobuf.Timestamp} Timestamp instance
             */
            Timestamp.create = function create(properties) {
                return new Timestamp(properties)
            }

            /**
             * Encodes the specified Timestamp message. Does not implicitly {@link google.protobuf.Timestamp.verify|verify} messages.
             * @function encode
             * @memberof google.protobuf.Timestamp
             * @static
             * @param {google.protobuf.ITimestamp} message Timestamp message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            Timestamp.encode = function encode(message, writer) {
                if (!writer) {
                    writer = $Writer.create()
                }
                if (message.seconds != null && Object.hasOwnProperty.call(message, 'seconds')) {
                    writer.uint32(/* id 1, wireType 0 =*/ 8).int64(message.seconds)
                }
                if (message.nanos != null && Object.hasOwnProperty.call(message, 'nanos')) {
                    writer.uint32(/* id 2, wireType 0 =*/ 16).int32(message.nanos)
                }
                return writer
            }

            /**
             * Encodes the specified Timestamp message, length delimited. Does not implicitly {@link google.protobuf.Timestamp.verify|verify} messages.
             * @function encodeDelimited
             * @memberof google.protobuf.Timestamp
             * @static
             * @param {google.protobuf.ITimestamp} message Timestamp message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            Timestamp.encodeDelimited = function encodeDelimited(message, writer) {
                return this.encode(message, writer).ldelim()
            }

            /**
             * Decodes a Timestamp message from the specified reader or buffer.
             * @function decode
             * @memberof google.protobuf.Timestamp
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @param {number} [length] Message length if known beforehand
             * @returns {google.protobuf.Timestamp} Timestamp
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            Timestamp.decode = function decode(reader, length) {
                if (!(reader instanceof $Reader)) {
                    reader = $Reader.create(reader)
                }
                var end = length === undefined ? reader.len : reader.pos + length,
                    message = new $root.google.protobuf.Timestamp()
                while (reader.pos < end) {
                    var tag = reader.uint32()
                    switch (tag >>> 3) {
                        case 1:
                            message.seconds = reader.int64()
                            break
                        case 2:
                            message.nanos = reader.int32()
                            break
                        default:
                            reader.skipType(tag & 7)
                            break
                    }
                }
                return message
            }

            /**
             * Decodes a Timestamp message from the specified reader or buffer, length delimited.
             * @function decodeDelimited
             * @memberof google.protobuf.Timestamp
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @returns {google.protobuf.Timestamp} Timestamp
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            Timestamp.decodeDelimited = function decodeDelimited(reader) {
                if (!(reader instanceof $Reader)) {
                    reader = new $Reader(reader)
                }
                return this.decode(reader, reader.uint32())
            }

            /**
             * Verifies a Timestamp message.
             * @function verify
             * @memberof google.protobuf.Timestamp
             * @static
             * @param {Object.<string,*>} message Plain object to verify
             * @returns {string|null} `null` if valid, otherwise the reason why it is not
             */
            Timestamp.verify = function verify(message) {
                if (typeof message !== 'object' || message === null) {
                    return 'object expected'
                }
                if (message.seconds != null && message.hasOwnProperty('seconds')) {
                    if (
                        !$util.isInteger(message.seconds) &&
                        !(
                            message.seconds &&
                            $util.isInteger(message.seconds.low) &&
                            $util.isInteger(message.seconds.high)
                        )
                    ) {
                        return 'seconds: integer|Long expected'
                    }
                }
                if (message.nanos != null && message.hasOwnProperty('nanos')) {
                    if (!$util.isInteger(message.nanos)) {
                        return 'nanos: integer expected'
                    }
                }
                return null
            }

            /**
             * Creates a Timestamp message from a plain object. Also converts values to their respective internal types.
             * @function fromObject
             * @memberof google.protobuf.Timestamp
             * @static
             * @param {Object.<string,*>} object Plain object
             * @returns {google.protobuf.Timestamp} Timestamp
             */
            Timestamp.fromObject = function fromObject(object) {
                if (object instanceof $root.google.protobuf.Timestamp) {
                    return object
                }
                var message = new $root.google.protobuf.Timestamp()
                if (object.seconds != null) {
                    if ($util.Long) {
                        ;(message.seconds = $util.Long.fromValue(object.seconds)).unsigned = false
                    } else if (typeof object.seconds === 'string') {
                        message.seconds = parseInt(object.seconds, 10)
                    } else if (typeof object.seconds === 'number') {
                        message.seconds = object.seconds
                    } else if (typeof object.seconds === 'object') {
                        message.seconds = new $util.LongBits(
                            object.seconds.low >>> 0,
                            object.seconds.high >>> 0
                        ).toNumber()
                    }
                }
                if (object.nanos != null) {
                    message.nanos = object.nanos | 0
                }
                return message
            }

            /**
             * Creates a plain object from a Timestamp message. Also converts values to other types if specified.
             * @function toObject
             * @memberof google.protobuf.Timestamp
             * @static
             * @param {google.protobuf.Timestamp} message Timestamp
             * @param {$protobuf.IConversionOptions} [options] Conversion options
             * @returns {Object.<string,*>} Plain object
             */
            Timestamp.toObject = function toObject(message, options) {
                if (!options) {
                    options = {}
                }
                var object = {}
                if (options.defaults) {
                    if ($util.Long) {
                        var long = new $util.Long(0, 0, false)
                        object.seconds =
                            options.longs === String
                                ? long.toString()
                                : options.longs === Number
                                ? long.toNumber()
                                : long
                    } else {
                        object.seconds = options.longs === String ? '0' : 0
                    }
                    object.nanos = 0
                }
                if (message.seconds != null && message.hasOwnProperty('seconds')) {
                    if (typeof message.seconds === 'number') {
                        object.seconds = options.longs === String ? String(message.seconds) : message.seconds
                    } else {
                        object.seconds =
                            options.longs === String
                                ? $util.Long.prototype.toString.call(message.seconds)
                                : options.longs === Number
                                ? new $util.LongBits(message.seconds.low >>> 0, message.seconds.high >>> 0).toNumber()
                                : message.seconds
                    }
                }
                if (message.nanos != null && message.hasOwnProperty('nanos')) {
                    object.nanos = message.nanos
                }
                return object
            }

            /**
             * Converts this Timestamp to JSON.
             * @function toJSON
             * @memberof google.protobuf.Timestamp
             * @instance
             * @returns {Object.<string,*>} JSON object
             */
            Timestamp.prototype.toJSON = function toJSON() {
                return this.constructor.toObject(this, $protobuf.util.toJSONOptions)
            }

            return Timestamp
        })()

        return protobuf
    })()

    return google
})()

module.exports = $root
