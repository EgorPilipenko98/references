import {ParkedUsersSchema, ParkingSchema, PartnerSchema, UserSchema} from '../db-schema';
import {Log} from './logger';
import {DataTypes, SocketService, TransferData} from './socketIo';
import NodeCache from 'node-cache';
import {UserStoryService} from './user-story';
import {ParkingModel, PartnerModel} from '../model';
import {CoordinatesCalc} from '../utils';

const userStory = new UserStoryService();
const TIME_TO_LIVE: number = 1200;
const MILLISECONDS_IN_DAY = 1000 * 60 * 60 * 24;

const EARTH_RADIUS_KM = 6378.1;
const DETECT_PARKING_RADIUS = 0.5; // km

const TIME_TO_FIND_PARKING = 1000 * 60 * 15; //15 min

const cache: NodeCache = new NodeCache({stdTTL: TIME_TO_LIVE, checkperiod: 60});
cache.on('expired', () => {
    const sendData: NodeCache.Data = cache.mget(cache.keys());
    SocketService.send(DataTypes.LiveUsers, sendData);
});


interface UserInfoData {
    firstName: string,
    lastName: string,
    email: string,
    owners: string[],
    timeOfExistence: number,
    lat: string,
    lng: string
}


export class UserService {

    static async saveInCache(userId: string, lat: string, lng: string) {
        try {
            const user = await UserSchema.findById({_id: userId});
            if (!user) {
                return new Error('User not found');
            }
            const jsonUser = user.toJSON();
            const createdDate = new Date(jsonUser.creationDate);
            const dateNow = new Date(Date.now());
            const daysAfterRegistration = Math.floor(
                (dateNow.getTime() - createdDate.getTime()) / MILLISECONDS_IN_DAY);
            let partnersIds = jsonUser.owners;
            let partnersNames: string [] = [];
            if (!!partnersIds.length) {
                partnersNames = await PartnerSchema.find({_id: {$in: partnersIds}}).then(partners => {
                    return partners.map(partner => PartnerModel.fromDb(partner).name);
                });
            }
            const data: UserInfoData = {
                firstName: jsonUser.firstName,
                lastName: jsonUser.lastName || '',
                owners: partnersNames,
                email: jsonUser.email,
                timeOfExistence: daysAfterRegistration,
                lat,
                lng
            };
            cache.set(userId, data);
            const sendData: NodeCache.Data = cache.mget(cache.keys());
            SocketService.send(DataTypes.LiveUsers, sendData);
        } catch (e) {
            throw new Error(e);
        }
    }

    static async registerLoginAttempt(_id: string) {
        try {
            return UserSchema.findOneAndUpdate({_id}, {
                $set: {lastLoginDate: new Date()},
                $inc: {loginAttempts: 1}
            });
        } catch (err) {
            Log.error(`[UserService.registerLoginAttempt] Error[${err}]`);
        }
    }

    static async updateLocation(userId: string, lat: string, lng: string) {
        Log.debug({userId, lat, lng}, `[UserService.updateLocation] Start`);
        try {
            await UserSchema.findOneAndUpdate({_id: userId}, {
                $set: {
                    lastLocation: {type: 'Point', coordinates: [+lng, +lat]}
                }
            });
            await userStory.updateLocationPosition(userId, lat, lng);
            Log.debug({userId, lat, lng}, `[UserService.updateLocation] Done`);
            this.setParkedUser(+lat, +lng, userId);
            return UserService.saveInCache(userId, lat, lng);
        } catch (err) {
            Log.error(`[UserService.updateLocation] lat=${lat} lng=${lng}Error[${err}]`);
        }
    }

    static async setParkedUser(userLat: number, userLng: number, userId: string): Promise<void> {
        const lastParkedEvent = await (ParkedUsersSchema.findOne({
            userId,
            parkedTime: {$gte: new Date(Date.now() - TIME_TO_FIND_PARKING)}
        }) as any).cache(60, 'setParkedUser-' + userId);
        if (lastParkedEvent) {
            return
        }
        const nearParkings = await this.getNearestParkings(userLat, userLng, DETECT_PARKING_RADIUS);
        if (!nearParkings.length) {
            return
        }
        const user = (await UserSchema.findById(userId)).toJSON();
        if (!user) {
            return;
        }
        const distanceFromUserToNearParking: { id: string, distance: number }[] =
            nearParkings.map((nearParking: any) => {
                const {lat, lng} = nearParking.location;
                return {
                    id: nearParking.id,
                    distance: CoordinatesCalc.latLng2distance(
                        userLat, userLng, lat, lng
                    ) / 1000
                };
            });
        const nearestDistanceBetweenUserAndParking = Math.min(
            ...distanceFromUserToNearParking.map(p => p.distance));

        const nearestParking = distanceFromUserToNearParking.find(
            v => v.distance === nearestDistanceBetweenUserAndParking);
        const forRecord = {
            userId,
            parkingId: nearestParking.id,
            distanceFromUserToParking: nearestParking.distance,
            parkedLocation: {type: 'Point', coordinates: user.lastLocation.coordinates.reverse()},
            parkedTime: new Date()
        };
        await ParkedUsersSchema.create(forRecord);
    }

    static getNearestParkings(lat: number, lng: number, radius: number): Promise<ParkingModel[]> {
        const query = {
            'location': {
                $geoWithin: {
                    $centerSphere: [[lng, lat], radius / EARTH_RADIUS_KM]
                }
            }
        };
        return ParkingSchema.find(query).then(parkings => parkings.map(ParkingModel.fromDb));
    }
}


SocketService.receive(DataTypes.LiveUsers, (transferMessage: TransferData) => {
    const sendData: NodeCache.Data = cache.mget(cache.keys());
    SocketService.send(DataTypes.LiveUsers, sendData, transferMessage.socketId);
});
