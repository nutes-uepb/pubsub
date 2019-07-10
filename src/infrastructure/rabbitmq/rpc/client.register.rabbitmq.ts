import { IClientRequest } from '../../port/rpc/resource.handler.interface'
import { inject, injectable } from 'inversify'
import { Identifier } from '../../../di/identifier'
import { ICustomLogger } from '../../../utils/custom.logger'
import { IConnection } from '../../port/connection/connection.interface'
import { IClientRegister } from '../../port/rpc/client.register.interface'
import { IConfigurationParameters } from '../../port/configuration.inteface'
import { ICustomEventEmitter } from '../../../utils/custom.event.emitter'

@injectable()
export class ClientRegisterRabbitmq implements IClientRegister {

    private _timeout: number

    constructor(@inject(Identifier.RABBITMQ_CONNECTION) private readonly _connection: IConnection,
                @inject(Identifier.CUSTOM_LOGGER) private readonly _logger: ICustomLogger,
                @inject(Identifier.CUSTOM_EVENT_EMITTER) private readonly _emitter: ICustomEventEmitter) {

    }

    public setConfigurations(config: IConfigurationParameters): void {
        this._connection.setConfigurations(config)
        this._timeout = this._connection.configurations.options.rcpTimeout
    }

    public registerClientDirectOrTopic(type: string,
                                       exchangeName: string,
                                       resource: IClientRequest,
                                       callback?: (err, message: any) => void): Promise<any> {
        return new Promise<any>(async (resolve, reject) => {
            try {

                if (!this._connection.startingConnection) {
                    await this._connection.tryConnect()
                }

                if (!this._connection.isConnected)
                    return resolve(false)

                const exchange = this._connection.getExchange(exchangeName, type);

                let time

                if (this._timeout > 0) {
                    new Promise<any>((resolve) => {
                        time = setTimeout(resolve, this._timeout)
                    }).then(() => {
                        reject(new Error('rpc timed out'))
                    })
                }

                exchange.rpc(resource, resource.resourceName, (err, msg) => {
                    clearTimeout(time)

                    let mensage = msg.getContent()

                    if (err) {
                        return reject(err)
                    }

                    return resolve(mensage)

                }).catch(e => {
                    console.log(e)
                    this._logger.error('WWithout server response!')
                })

                this._logger.info('Client registered in ' + exchangeName + ' exchange!')


            } catch (err) {
                return reject(err)
            }
        })
    }

    public closeConnection(): Promise<boolean> {
        return this._connection.closeConnection()
    }

}
