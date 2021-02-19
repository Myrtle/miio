'use strict';

const { ChargingState, AutonomousCharging } = require('abstract-things');
const {
	Vacuum, AdjustableFanSpeed, AutonomousCleaning, SpotCleaning
} = require('abstract-things/climate');

const MiioApi = require('../device');
const BatteryLevel = require('./capabilities/battery-level');

function checkResult(r) {
	//console.log(r)
	// {"result":0,"id":17} 	  = Firmware 3.3.9_003095 (Gen1)
	// {"result":["ok"],"id":11}  = Firmware 3.3.9_003194 (Gen1), 3.3.9_001168 (Gen2)
	if( r !== 0 && r[0] !== 'ok' ) {
		throw new Error('Could not complete call to device');
	}
}

/**
 * Implementation of the interface used by the Mi Robot Vacuum. This device
 * doesn't use properties via get_prop but instead has a get_status.
 */
module.exports = class extends Vacuum.with(
	MiioApi, BatteryLevel, AutonomousCharging, AutonomousCleaning,
	SpotCleaning, AdjustableFanSpeed, ChargingState
) {
	static get type() {
		return 'miio:vacuum';
	}

	constructor(options) {
		super(options);

		this.defineProperty('error_code', {
			name: 'error',
			mapper: e => {
				switch(e) {
					case 0:
						return null;
					default:
						return {
							code: e,
							message: 'Unknown error ' + e
						};
				}

				// TODO: Find a list of error codes and map them correctly
			}
		});

		this.defineProperty('state', s => {
			switch(s) {
				case 1:
					return 'initiating';
				case 2:
					return 'charger-offline';
				case 3:
					return 'waiting';
				case 5:
					return 'cleaning';
				case 6:
					return 'returning';
				case 8:
					return 'charging';
				case 9:
					return 'charging-error';
				case 10:
					return 'paused';
				case 11:
					return 'spot-cleaning';
				case 12:
					return 'error';
				case 13:
					return 'shutting-down';
				case 14:
					return 'updating';
				case 15:
					return 'docking';
				case 17:
					return 'zone-cleaning';
				case 100:
					return 'full';
			}
			return 'unknown-' + s;
		});

		// Define the batteryLevel property for monitoring battery
		this.defineProperty('battery', {
			name: 'batteryLevel'
		});

		this.defineProperty('clean_time', {
			name: 'cleanTime',
		});
		this.defineProperty('clean_area', {
			name: 'cleanArea',
			mapper: v => v / 1000000
		});
		this.defineProperty('fan_power', {
			name: 'fanSpeed'
		});
		this.defineProperty('in_cleaning');

		// Consumable status - times for brushes and filters
		this.defineProperty('main_brush_work_time', {
			name: 'mainBrushWorkTime'
		});
		this.defineProperty('side_brush_work_time', {
			name: 'sideBrushWorkTime'
		});
		this.defineProperty('filter_work_time', {
			name: 'filterWorkTime'
		});
		this.defineProperty('sensor_dirty_time', {
			name: 'sensorDirtyTime'
		});

		this._monitorInterval = 60000;
	}

	propertyUpdated(key, value, oldValue) {
		if(key === 'state') {
			// Update charging state
			this.updateCharging(value === 'charging');

			switch(value) {
				case 'cleaning':
				case 'spot-cleaning':
				case 'zone-cleaning':
					// The vacuum is cleaning
					this.updateCleaning(true);
					break;
				case 'paused':
					// Cleaning has been paused, do nothing special
					break;
				case 'error':
					// An error has occurred, rely on error mapping
					this.updateError(this.property('error'));
					break;
				case 'charging-error':
					// Charging error, trigger an error
					this.updateError({
						code: 'charging-error',
						message: 'Error during charging'
					});
					break;
				case 'charger-offline':
					// Charger is offline, trigger an error
					this.updateError({
						code: 'charger-offline',
						message: 'Charger is offline'
					});
					break;
				default:
					// The vacuum is not cleaning
					this.updateCleaning(false);
					break;
			}
		} else if(key === 'fanSpeed') {
			this.updateFanSpeed(value);
		}

		super.propertyUpdated(key, value, oldValue);
	}

	/**
	 * Start a cleaning session.
	 */
	activateCleaning() {
		return this.call('app_start', [], {
			refresh: [ 'state' ],
			refreshDelay: 1000
		})
			.then(checkResult);
	}

	/**
	 * Pause the current cleaning session.
	 */
	pause() {
		return this.call('app_pause', [], {
			refresh: [ 'state ']
		})
			.then(checkResult);
	}

	/**
	 * Stop the current cleaning session.
	 */
	deactivateCleaning() {
		return this.call('app_stop', [], {
			refresh: [ 'state' ],
			refreshDelay: 1000
		})
			.then(checkResult);
	}

	/**
	 * Stop the current cleaning session and return to charge.
	 */
	activateCharging() {
		return this.call('app_stop', [])
			.then(checkResult)
			.then(() => this.call('app_charge', [], {
				refresh: [ 'state' ],
				refreshDelay: 1000
			}))
			.then(checkResult);
	}

	/**
	 * Start cleaning the current spot.
	 */
	activateSpotClean() {
		return this.call('app_spot', [], {
			refresh: [ 'state' ]
		})
			.then(checkResult);
	}

	/**
	 * Set the power of the fan. Usually 38, 60 or 77.
	 */
	changeFanSpeed(speed) {
		return this.call('set_custom_mode', [ speed ], {
			refresh: [ 'fanSpeed' ]
		})
			.then(checkResult);
	}

	/**
	 * Start cleaning designed zones
	 *
	 * [array of [zone]]
	 * [
	 *  [26234, 26042, 27284, 26642, 1], // zone A should be cleaned once
     *  [26232, 25304, 27282, 25804, 2], // zone B should be cleaned twice
	 *  [26246, 24189, 27296, 25139, 3]  // zone C should be cleaned 3 times
	 * ]
	 */
	startCleanZones(zones) {
		return this.call('app_zoned_clean', [ zones ])
			.then(result => {
				return {
					serial: result
				}
			})
	}

	/**
	 * Start cleaning designed zones
	 */
	stopCleanZones() {
		return this.call('stop_zoned_clean')
			.then(result => {
				return {
					serial: result
				}
			})
	}

	/**
	 * Resume cleaning designed zones
	 */
	resumeCleanZones() {
		return this.call('resume_zoned_clean')
			.then(result => {
				return {
					serial: result
				}
			})
	}


	/**
	 * Go to map position
	 */
	goToTarget(x, y) {
		return this.call('app_goto_target', [x, y])
			.then(result => {
				return {
					serial: result
				}
			})
	}

	/**
	 * Activate the find function, will make the device give off a sound.
	 */
	find() {
		return this.call('find_me', [''])
			.then(() => null);
	}

	/**
	 * Get information about the cleaning history of the device. Contains
	 * information about the number of times it has been started and
	 * the days it has been run.
	 */
	getHistory() {
		return this.call('get_clean_summary')
			.then(result => {
				return {
					count: result[2],
					days: result[3].map(ts => new Date(ts * 1000))
				};
			});
	}

	getMap() {
		return this.call('get_map_v1')
			.then(result => {
				return {
					map: result
				};
			});
	}

	/**
	 * Get history for the specified day. The day should be fetched from
	 * `getHistory`.
	 */
	getHistoryForDay(day) {
		let record = day;
		if(record instanceof Date) {
			record = Math.floor(record.getTime() / 1000);
		}
		return this.call('get_clean_record', [ record ])
			.then(result => ({
				day: day,
				history: result.map(data => ({
					// Start and end times
					start: new Date(data[0] * 1000),
					end: new Date(data[1] * 1000),

					// How long it took in seconds
					duration: data[2],

					// Area in m2
					area: data[3] / 1000000,

					// If it was a complete run
					complete: data[5] === 1
				}))
			}));
	}

	/**
	 * Get Vacuum serial number
	 */
	getSerial() {
		return this.call('get_serial_number')
			.then(result => {
				return {
					serial: result[0].serial_number
				}
			})
	}

	/**
	 * Get Vacuum complete informations
	 */
	getInfo() {
		return this.call('miIO.info')
			.then(result => {
				return result
			})
	}

	/**
	 * Get wi-fi informations
	 */
	getWifiInformations() {
		return this.call('miIO.info')
			.then(result => {
				return result.ap
			})
	}

	/**
	 * Get network informations
	 */
	getNetwork() {
		return this.call('miIO.info')
			.then(result => {
				return result.netif
			})
	}

	/**
	 * Get status
	 *
	 * Response
		Key							Example		Description
		battery						100			Battery level (in %)
		clean_area					140000		Total area (in cm²)
		clean_time					15			Total cleaning time (in s)
		dnd_enabled					0			Is 'Do Not Disturb' enabled (0=disabled, 1=enabled)
		error_code					0			Error code (see list below)
		fan_power					102			Fan power, corresponds to the values in Custom Mode (see list)
		in_cleaning					0			Is device cleaning
		in_fresh_state				1			?
		in_returning				0			Is returning to dock (0=no, 1=yes)
		is_locating					0			?
		lab_status					1			?
		lock_status					0			?
		map_present					1			Is map present
		map_status					3			?
		mop_forbidden_enable		0			?
		msg_seq						52			Message sequence increments with each request
		msg_ver						2			Message version (seems always 4 and 2 for s6)
		state						8			Status code (see list below)
		water_box_carriage_status	0			Is carriage mounted (0=no, 1=yes)
		water_box_mode				204			Water quantity control, corresponds to the values in Water Box Custom Mode (see list)
		water_box_status			1			Is water tank mounted (0=no, 1=yes)

		Status Codes:
		0	Unknown
		1	Initiating
		2	Sleeping
		3	Idle
		4	Remote Control
		5	Cleaning
		6	Returning Dock
		7	Manual Mode
		8	Charging
		9	Charging Error
		10	Paused
		11	Spot Cleaning
		12	In Error
		13	Shutting Down
		14	Updating
		15	Docking
		16	Go To
		17	Zone Clean
		18	Room Clean
		100	Fully Charged

		Error Codes:
		0	No error
		1	Laser sensor fault
		2	Collision sensor fault
		3	Wheel floating
		4	Cliff sensor fault
		5	Main brush blocked
		6	Side brush blocked
		7	Wheel blocked
		8	Device stuck
		9	Dust bin missing
		10	Filter blocked
		11	Magnetic field detected
		12	Low battery
		13	Charging problem
		14	Battery failure
		15	Wall sensor fault
		16	Uneven surface
		17	Side brush failure
		18	Suction fan failure
		19	Unpowered charging station
		20	Unknown Error
		21	Laser pressure sensor problem
		22	Charge sensor problem
		23	Dock problem
		24	No-go zone or invisible wall detected
		254	Bin full
		255	Internal error
		-1	Unknown Error

	 */
	getStatus() {
		return this.call('get_status')
			.then(result => {
				return result[0]
			})
	}

	/**
	 * Get authentication token
	 */
	getToken() {
		return this.call('miIO.info')
			.then(result => {
				return {
					token: result.token
				}
			})
	}

	/**
	 * Get robot model informations
	 */
	getModel() {
		return this.call('miIO.info')
			.then(result => {
				return {
					fw: result.fw_ver,
					hw: result.hw_ver,
					mac: result.mac,
					life: result.life,
					model: result.model
				}
			})
	}

	/**
	 * Get all consumable status
	 */
	getConsumable() {
		return this.call('get_consumable')
			.then(result => {
				return result[0]
			})
	}

	/**
	 * Get the volume value (0-100)
	 */
	getSoundVolume() {
		return this.call('get_sound_volume')
			.then(result => {
				return result[0]
			})
	}

	/**
	 * Set new volume level
	 */
	setVolume(volume) {
		return this.call('change_sound_volume', volume)
		.then(result => {
			return result
		})
	}

	/**
	 * Get the current audio
	 */
	getCurrentSound() {
		return this.call('get_current_sound')
			.then(result => {
				return result[0]
			})
	}

	/**
	 * Play a test audio with current volume level
	 */
	testSoundVolume() {
		return this.call('test_sound_volume')
			.then(result => {
				return result[0]
			})
	}


	loadProperties(props) {
		// We override loadProperties to use get_status and get_consumables
		props = props.map(key => this._reversePropertyDefinitions[key] || key);

		return Promise.all([
			this.call('get_status'),
			this.call('get_consumable')
		]).then(result => {
			const status = result[0][0];
			const consumables = result[1][0];

			const mapped = {};
			props.forEach(prop => {
				let value = status[prop];
				if(typeof value === 'undefined') {
					value = consumables[prop];
				}
				this._pushProperty(mapped, prop, value);
			});
			return mapped;
		});
	}
};
