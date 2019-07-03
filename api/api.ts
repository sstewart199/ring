import { clientApi, RingAuth, RingRestClient } from './rest-client'
import { Location } from './location'
import {
  ActiveDing,
  BaseStation,
  BeamBridge,
  CameraData,
  HistoricalDingGlobal,
  UserLocation
} from './ring-types'
import { RingCamera } from './ring-camera'
import { EMPTY, merge, Subject } from 'rxjs'
import { debounceTime, switchMap, throttleTime } from 'rxjs/operators'

export interface RingAlarmOptions {
  locationIds?: string[]
  cameraStatusPollingSeconds?: number
  cameraDingsPollingSeconds?: number
}

export class RingApi {
  public readonly restClient = new RingRestClient(this.options)

  private locations = this.fetchAndBuildLocations()

  constructor(public readonly options: RingAlarmOptions & RingAuth) {}

  async fetchRingDevices() {
    const {
      doorbots,
      authorized_doorbots: authorizedDoorbots,
      stickup_cams: stickupCams,
      base_stations: baseStations,
      beams_bridges: beamBridges
    } = await this.restClient.request<{
      doorbots: CameraData[]
      authorized_doorbots: CameraData[]
      stickup_cams: CameraData[]
      base_stations: BaseStation[]
      beams_bridges: BeamBridge[]
    }>({ url: clientApi('ring_devices') })

    if (this.restClient.using2fa && this.restClient.refreshToken) {
      console.error(
        'Your Ring account is configured to use 2-factor authentication (2fa).'
      )
      console.error(
        `Please change your Ring configuration to include "refreshToken": "${this.restClient.refreshToken}"`
      )
      process.exit(1)
    }

    return {
      doorbots,
      authorizedDoorbots,
      stickupCams,
      allCameras: doorbots.concat(stickupCams, authorizedDoorbots),
      baseStations,
      beamBridges
    }
  }

  fetchActiveDings() {
    return this.restClient.request<ActiveDing[]>({
      url: clientApi('dings/active?burst=false')
    })
  }

  private listenForCameraUpdates(cameras: RingCamera[]) {
    const {
        cameraStatusPollingSeconds,
        cameraDingsPollingSeconds
      } = this.options,
      camerasRequestUpdate$ = merge(
        ...cameras.map(camera => camera.onRequestUpdate)
      ).pipe(throttleTime(500)),
      onUpdateReceived = new Subject(),
      onPollForStatusUpdate = cameraStatusPollingSeconds
        ? onUpdateReceived.pipe(debounceTime(cameraStatusPollingSeconds * 1000))
        : EMPTY,
      camerasById = cameras.reduce(
        (byId, camera) => {
          byId[camera.id] = camera
          return byId
        },
        {} as { [id: number]: RingCamera }
      )

    if (!cameras.length) {
      return
    }

    merge(camerasRequestUpdate$, onPollForStatusUpdate)
      .pipe(
        throttleTime(500),
        switchMap(async () => {
          const response = await this.fetchRingDevices().catch(() => null)
          return response && response.allCameras
        })
      )
      .subscribe(cameraData => {
        onUpdateReceived.next()

        if (!cameraData) {
          return
        }

        cameraData.forEach(data => {
          const camera = camerasById[data.id]
          if (camera) {
            camera.updateData(data)
          }
        })
      })

    if (cameraStatusPollingSeconds) {
      onUpdateReceived.next() // kick off polling
    }

    if (cameraDingsPollingSeconds) {
      const onPollForActiveDings = new Subject()

      onPollForActiveDings
        .pipe(
          debounceTime(cameraDingsPollingSeconds * 1000),
          switchMap(() => {
            return this.fetchActiveDings().catch(() => null)
          })
        )
        .subscribe(activeDings => {
          onPollForActiveDings.next()

          if (!activeDings || !activeDings.length) {
            return
          }

          activeDings.forEach(activeDing => {
            const camera = camerasById[activeDing.doorbot_id]
            if (camera) {
              camera.processActiveDing(activeDing)
            }
          })
        })

      onPollForActiveDings.next() // kick off polling
    }
  }

  async fetchRawLocations() {
    const { user_locations: rawLocations } = await this.restClient.request<{
      user_locations: UserLocation[]
    }>({ url: 'https://app.ring.com/rhq/v1/devices/v1/locations' })

    return rawLocations
  }

  async fetchAndBuildLocations() {
    const rawLocations = await this.fetchRawLocations(),
      {
        authorizedDoorbots,
        doorbots,
        allCameras,
        baseStations,
        beamBridges
      } = await this.fetchRingDevices(),
      locationIdsWithHubs = [...baseStations, ...beamBridges].map(
        x => x.location_id
      ),
      cameras = allCameras.map(
        data =>
          new RingCamera(
            data,
            doorbots.includes(data) || authorizedDoorbots.includes(data),
            this.restClient
          )
      ),
      locations = rawLocations
        .filter(location => {
          return (
            !Array.isArray(this.options.locationIds) ||
            this.options.locationIds.includes(location.location_id)
          )
        })
        .map(
          location =>
            new Location(
              location,
              cameras.filter(x => x.data.location_id === location.location_id),
              locationIdsWithHubs.includes(location.location_id),
              this.restClient
            )
        )

    this.listenForCameraUpdates(cameras)

    return locations
  }

  getLocations() {
    return this.locations
  }

  async getCameras() {
    const locations = await this.locations
    return locations.reduce(
      (cameras, location) => [...cameras, ...location.cameras],
      [] as RingCamera[]
    )
  }

  getHistory(limit = 10, favoritesOnly = false) {
    const favoritesParam = favoritesOnly ? '&favorites=1' : ''
    return this.restClient.request<HistoricalDingGlobal[]>({
      url: clientApi(`doorbots/history?limit=${limit}${favoritesParam}`)
    })
  }
}
