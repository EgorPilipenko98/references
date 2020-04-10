import SocketIO from 'socket.io';
import PubSub from 'pubsub-js';
import {Server} from 'http';
import jwt from 'jsonwebtoken';
import {JWT_SECRET} from '../routes/auth'

interface ConnectedSocket {
    id: string,
    socket: SocketIO.Socket,
    types?: DataTypes[]
}

export enum DataTypes {
    LiveUsers = 'live-users',
}

export enum SocketIoEvents {
    MessageEvent = 'messageEvent',
    ListeningEvent = 'listening',
    NotListeningEvent = 'not_listening'
}

export interface TransferData {
    type: DataTypes
    id?: string
    link?: string,
    socketId?: string,
    data: any
}

let socketsPool: ConnectedSocket[] = [];

const SOCKET_IO_MESSAGE_EVENT: string = 'socket_io_message_event';

export class SocketService {
    static runSocketIOServer(server: Server) {
        const io: SocketIO.Server = SocketIO(server);
        io.use((socket: SocketIO.Socket, next: Function) => {
            if (socket.handshake.query && socket.handshake.query.token) {
                jwt.verify(socket.handshake.query.token, JWT_SECRET, (err, decoded) => {
                    if (err) {
                        return next(new Error('Authentication error'));
                    }
                    next();
                });
            } else {
                next(new Error('Authentication error'));
            }
        })
            .on('connection', (socket: SocketIO.Socket) => {
                socketsPool.push({socket, id: socket.id, types: []});
                socket.on('disconnect', () => {
                    const disconnectedSocket: ConnectedSocket = socketsPool.find(s => s.id === socket.id);
                    socketsPool.splice(socketsPool.indexOf(disconnectedSocket), 1);
                });
                socket.on(SocketIoEvents.ListeningEvent, (type: DataTypes) => {
                    let currentSocket: ConnectedSocket = socketsPool.find(s => s.id === socket.id);
                    currentSocket.types.push(type);
                });
                socket.on(SocketIoEvents.NotListeningEvent, (type: DataTypes) => {
                    let currentSocket: ConnectedSocket = socketsPool.find(s => s.id === socket.id);
                    const delType = currentSocket.types.indexOf(type);
                    currentSocket.types.splice(delType, 1);
                });
                socket.on(SocketIoEvents.MessageEvent, (transferMessage: TransferData) => {
                    transferMessage.socketId = socket.id;
                    PubSub.publish(SOCKET_IO_MESSAGE_EVENT + transferMessage.type, transferMessage);
                });
            });
    }

    static send(type: DataTypes, data: any, socketId?: string): void {
        let transferMessage: TransferData = {
            type,
            data
        };
        const socketsToSend = socketId ? [socketsPool.find(s => s.socket.id === socketId)] : socketsPool;
        socketsToSend.forEach(s => {
            if (s && s.types.includes(type)) {
                s.socket.emit(SocketIoEvents.MessageEvent, transferMessage);
            }
        });
    }

    static receive(type: DataTypes, cb: (message: TransferData) => void): string {
        return PubSub.subscribe(SOCKET_IO_MESSAGE_EVENT + type, (msgName: string, transferMessage: TransferData) => {
            cb(transferMessage);
        });
    }

    static stopReceiving(subscriptionToken: string) {
        PubSub.unsubscribe(subscriptionToken);
    }

}

