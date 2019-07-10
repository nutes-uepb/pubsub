import { Connection, log } from '../connection/connection'
import { Binding } from './binding'
import { Message } from './message'
import { Exchange } from './exchange'
import * as AmqpLib from 'amqplib/callback_api';

const DIRECT_REPLY_TO_QUEUE = "amq.rabbitmq.reply-to";

export class Queue {
    initialized: Promise<Queue.InitializeResult>;

    _connection: Connection;
    _channel: AmqpLib.Channel;
    _name: string;
    _options: Queue.DeclarationOptions;

    _consumer: (msg: any, channel?: AmqpLib.Channel) => any;
    _isStartConsumer: boolean;
    _rawConsumer: boolean;
    _consumerOptions: Queue.StartConsumerOptions;
    _consumerTag: string;
    _consumerInitialized: Promise<Queue.StartConsumerResult>;
    _consumerStopping: boolean;
    _deleting: Promise<Queue.DeleteResult>;
    _closing: Promise<void>;

    get name() {
        return this._name;
    }

    constructor(connection: Connection, name: string, options: Queue.DeclarationOptions = {}) {
        this._connection = connection;
        this._name = name;
        this._options = options;
        this._connection._queues[this._name] = this;
        this._initialize();
    }

    _initialize(): void {
        this.initialized = new Promise<Queue.InitializeResult>((resolve, reject) => {
            this._connection.initialized.then(() => {
                this._connection._connection.createChannel((err, channel) => {
                    /* istanbul ignore if */
                    if (err) {
                        reject(err);
                    } else {
                        this._channel = channel;
                        let callback = (err, ok) => {
                            /* istanbul ignore if */
                            if (err) {
                                log.log("error", "Failed to create queue '" + this._name + "'.", { module: "amqp-ts" });
                                delete this._connection._queues[this._name];
                                reject(err);
                            } else {
                                if (this._options.prefetch) {
                                    this._channel.prefetch(this._options.prefetch);
                                }
                                resolve(<Queue.InitializeResult>ok);
                            }
                        };

                        if (this._options.noCreate) {
                            this._channel.checkQueue(this._name, callback);
                        } else {
                            this._channel.assertQueue(this._name, <AmqpLib.Options.AssertQueue>this._options, callback);
                        }
                    }
                });
            }).catch((err) => {
                log.log("warn", "Channel failure, error caused during connection!", { module: "amqp-ts" });
            });
        });
    }

    static _packMessageContent(content: any, options: any): Buffer {
        if (typeof content === "string") {
            content = new Buffer(content);
        } else if (!(content instanceof Buffer)) {
            content = new Buffer(JSON.stringify(content));
            options.contentType = "application/json";
        }
        return content;
    }

    static _unpackMessageContent(msg: AmqpLib.Message): any {
        var content = msg.content.toString();
        if (msg.properties.contentType === "application/json") {
            content = JSON.parse(content);
        }
        return content;
    }

    /**
     * deprecated, use 'queue.send(message: Message)' instead
     */
    publish(content: any, options: any = {}): void {
        // inline function to send the message
        var sendMessage = () => {
            try {
                this._channel.sendToQueue(this._name, content, options);
            } catch (err) {
                log.log("debug", "Queue publish error: " + err.message, { module: "amqp-ts" });
                var queueName = this._name;
                var connection = this._connection;
                log.log("debug", "Try to rebuild connection, before Call.", { module: "amqp-ts" });
                connection._rebuildAll(err).then(() => {
                    log.log("debug", "Retransmitting message.", { module: "amqp-ts" });
                    connection._queues[queueName].publish(content, options);
                });
            }
        };

        content = Queue._packMessageContent(content, options);
        // execute sync when possible
        // if (this.initialized.isFulfilled()) {
        //   sendMessage();
        // } else {
        this.initialized.then(sendMessage);
        // }
    }

    send(message: Message, routingKey = ""): void {
        message.sendTo(this, routingKey);
    }

    rpc(requestParameters: any): Promise<Message> {
        return new Promise<Message>((resolve, reject) => {
            var processRpc = () => {
                var consumerTag: string;
                this._channel.consume(DIRECT_REPLY_TO_QUEUE, (resultMsg) => {
                    this._channel.cancel(consumerTag);
                    var result = new Message(resultMsg.content, resultMsg.fields);
                    result.fields = resultMsg.fields;
                    resolve(result);
                }, { noAck: true }, (err, ok) => {
                    /* istanbul ignore if */
                    if (err) {
                        reject(new Error("amqp-ts: Queue.rpc error: " + err.message));
                    } else {
                        // send the rpc request
                        consumerTag = ok.consumerTag;
                        var message = new Message(requestParameters, { replyTo: DIRECT_REPLY_TO_QUEUE });
                        message.sendTo(this);
                    }
                });
            };

            let sync: boolean = false

            this.initialized.then(() => sync )

            // execute sync when possible
            // if (this.initialized.isFulfilled()) {
            //   processRpc();
            // } else {
            this.initialized.then(processRpc);
            // }
        });
    }

    prefetch(count: number): void {
        this.initialized.then(() => {
            this._channel.prefetch(count);
            this._options.prefetch = count;
        });
    }

    recover(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this.initialized.then(() => {
                this._channel.recover((err, ok) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(null);
                    }
                });
            });
        });
    }

    /**
     * deprecated, use 'queue.activateConsumer(...)' instead
     */
    startConsumer(onMessage: (msg: any, channel?: AmqpLib.Channel) => any,
                  options: Queue.StartConsumerOptions = {})
        : Promise<Queue.StartConsumerResult> {
        if (this._consumerInitialized) {
            return new Promise<Queue.StartConsumerResult>((_, reject) => {
                reject(new Error("amqp-ts Queue.startConsumer error: consumer already defined"));
            });
        }

        this._isStartConsumer = true;
        this._rawConsumer = (options.rawMessage === true);
        delete options.rawMessage; // remove to avoid possible problems with amqplib
        this._consumerOptions = options;
        this._consumer = onMessage;
        this._initializeConsumer();

        return this._consumerInitialized;
    }

    activateConsumer(onMessage: (msg: Message) => any,
                     options: Queue.ActivateConsumerOptions = {})
        : Promise<Queue.StartConsumerResult> {
        if (this._consumerInitialized) {
            return new Promise<Queue.StartConsumerResult>((_, reject) => {
                reject(new Error("amqp-ts Queue.activateConsumer error: consumer already defined"));
            });
        }

        this._consumerOptions = options;
        this._consumer = onMessage;
        this._initializeConsumer();

        return this._consumerInitialized;
    }

    _initializeConsumer(): void {
        var processedMsgConsumer = (msg: AmqpLib.Message) => {
            try {
                /* istanbul ignore if */
                if (!msg) {
                    return; // ignore empty messages (for now)
                }
                var payload = Queue._unpackMessageContent(msg);
                var result = this._consumer(payload);
                // check if there is a reply-to
                if (msg.properties.replyTo) {
                    var options: any = {};
                    if (result instanceof Promise) {
                        result.then((resultValue) => {
                            resultValue = Queue._packMessageContent(result, options);
                            this._channel.sendToQueue(msg.properties.replyTo, resultValue, options);
                        }).catch((err) => {
                            log.log("error", "Queue.onMessage RPC promise returned error: " + err.message, { module: "amqp-ts" });
                        });
                    } else {
                        result = Queue._packMessageContent(result, options);
                        this._channel.sendToQueue(msg.properties.replyTo, result, options);
                    }
                }

                if (this._consumerOptions.noAck !== true) {
                    this._channel.ack(msg);
                }
            } catch (err) {
                /* istanbul ignore next */
                log.log("error", "Queue.onMessage consumer function returned error: " + err.message, { module: "amqp-ts" });
            }
        };

        var rawMsgConsumer = (msg: AmqpLib.Message) => {
            try {
                this._consumer(msg, this._channel);
            } catch (err) {
                /* istanbul ignore next */
                log.log("error", "Queue.onMessage consumer function returned error: " + err.message, { module: "amqp-ts" });
            }
        };

        var activateConsumerWrapper = (msg: AmqpLib.Message) => {
            try {
                var message = new Message(msg.content, msg.properties);
                message.fields = msg.fields;
                message._message = msg;
                message._channel = this._channel;
                var result = this._consumer(message);
                // check if there is a reply-to
                if (msg.properties.replyTo) {
                    if (result instanceof Promise) {
                        result.then((resultValue) => {
                            if (!(resultValue instanceof Message)) {
                                resultValue = new Message(resultValue, {});
                            }
                            resultValue.properties.correlationId = msg.properties.correlationId;
                            this._channel.sendToQueue(msg.properties.replyTo, resultValue.content, resultValue.properties);
                        }).catch((err) => {
                            log.log("error", "Queue.onMessage RPC promise returned error: " + err.message, { module: "amqp-ts" });
                        });
                    } else {
                        if (!(result instanceof Message)) {
                            result = new Message(result, {});
                        }
                        result.properties.correlationId = msg.properties.correlationId;
                        this._channel.sendToQueue(msg.properties.replyTo, result.content, result.properties);
                    }
                }
            } catch (err) {
                /* istanbul ignore next */
                log.log("error", "Queue.onMessage consumer function returned error: " + err.message, { module: "amqp-ts" });
            }
        };

        this._consumerInitialized = new Promise<Queue.StartConsumerResult>((resolve, reject) => {
            this.initialized.then(() => {
                var consumerFunction = activateConsumerWrapper;
                if (this._isStartConsumer) {
                    consumerFunction = this._rawConsumer ? rawMsgConsumer : processedMsgConsumer;
                }
                this._channel.consume(this._name, consumerFunction, <AmqpLib.Options.Consume>this._consumerOptions, (err, ok) => {
                    /* istanbul ignore if */
                    if (err) {
                        reject(err);
                    } else {
                        this._consumerTag = ok.consumerTag;
                        resolve(ok);
                    }
                });
            });
        });
    }

    stopConsumer(): Promise<void> {
        if (!this._consumerInitialized || this._consumerStopping) {
            return Promise.resolve();
        }
        this._consumerStopping = true;
        return new Promise<void>((resolve, reject) => {
            this._consumerInitialized.then(() => {
                this._channel.cancel(this._consumerTag, (err, ok) => {
                    /* istanbul ignore if */
                    if (err) {
                        reject(err);
                    } else {
                        delete this._consumerInitialized;
                        delete this._consumer;
                        delete this._consumerOptions;
                        delete this._consumerStopping;
                        resolve(null);
                    }
                });
            });
        });
    }

    delete(): Promise<Queue.DeleteResult> {
        if (this._deleting === undefined) {
            this._deleting = new Promise<Queue.DeleteResult>((resolve, reject) => {
                this.initialized.then(() => {
                    return Binding.removeBindingsContaining(this);
                }).then(() => {
                    return this.stopConsumer();
                }).then(() => {
                    return this._channel.deleteQueue(this._name, {}, (err, ok) => {
                        /* istanbul ignore if */
                        if (err) {
                            reject(err);
                        } else {
                            delete this.initialized; // invalidate queue
                            delete this._connection._queues[this._name]; // remove the queue from our administration
                            this._channel.close((err) => {
                                /* istanbul ignore if */
                                if (err) {
                                    reject(err);
                                } else {
                                    delete this._channel;
                                    delete this._connection;
                                    resolve(<Queue.DeleteResult>ok);
                                }
                            });
                        }
                    });
                }).catch((err) => {
                    reject(err);
                });
            });
        }
        return this._deleting;
    }

    close(): Promise<void> {
        if (this._closing === undefined) {
            this._closing = new Promise<void>((resolve, reject) => {
                this.initialized.then(() => {
                    return Binding.removeBindingsContaining(this);
                }).then(() => {
                    return this.stopConsumer();
                }).then(() => {
                    delete this.initialized; // invalidate queue
                    delete this._connection._queues[this._name]; // remove the queue from our administration
                    this._channel.close((err) => {
                        /* istanbul ignore if */
                        if (err) {
                            reject(err);
                        } else {
                            delete this._channel;
                            delete this._connection;
                            resolve(null);
                        }
                    });
                }).catch((err) => {
                    reject(err);
                });
            });
        }
        return this._closing;
    }

    bind(source: Exchange, pattern = "", args: any = {}): Promise<Binding> {
        var binding = new Binding(this, source, pattern, args);
        return binding.initialized;
    }

    unbind(source: Exchange, pattern = "", args: any = {}): Promise<void> {
        return this._connection._bindings[Binding.id(this, source, pattern)].delete();
    }
}
export namespace Queue {
    "use strict";
    export interface DeclarationOptions {
        exclusive?: boolean;
        durable?: boolean;
        autoDelete?: boolean;
        arguments?: any;
        messageTtl?: number;
        expires?: number;
        deadLetterExchange?: string;
        maxLength?: number;
        prefetch?: number;
        noCreate?: boolean;
    }
    export interface StartConsumerOptions {
        rawMessage?: boolean;
        consumerTag?: string;
        noLocal?: boolean;
        noAck?: boolean;
        exclusive?: boolean;
        priority?: number;
        arguments?: Object;
    }
    export interface ActivateConsumerOptions {
        consumerTag?: string;
        noLocal?: boolean;
        noAck?: boolean;
        exclusive?: boolean;
        priority?: number;
        arguments?: Object;
    }
    export interface StartConsumerResult {
        consumerTag: string;
    }
    export interface InitializeResult {
        queue: string;
        messageCount: number;
        consumerCount: number;
    }
    export interface DeleteResult {
        messageCount: number;
    }
}
