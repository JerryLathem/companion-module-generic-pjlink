var net = require('net')
var instance_skel = require('../../instance_skel')
var crypto = require('crypto')
var debug
var log

function instance(system, id, config) {
	var self = this

	// super-constructor
	instance_skel.apply(this, arguments)

	self.variables = {}
	self.actions() // export actions

	return self
}

instance.prototype.updateConfig = function (config) {
	var self = this

	self.config = config
	self.initVariables()
	self.getStaticVariables()
	self.getVariables()
}

instance.prototype.init = function () {
	var self = this

	debug = self.debug
	log = self.log

	self.commands = []

	self.status(self.STATUS_UNKNOWN, 'Connecting')
	self.initPresets()
	self.initVariables()
	self.initFeedbacks()
	self.getStaticVariables()
	self.getVariables()
}

instance.prototype.init_tcp = function (cb) {
	var self = this
	var receivebuffer = ''
	self.passwordstring = ''

	if (self.socketTimer) {
		clearInterval(self.socketTimer)
		delete self.socketTimer
	}

	if (self.socket !== undefined) {
		self.socket.destroy()
		delete self.socket
	}

	if (self.config.host) {
		self.connecting = true
		self.commands = []
		self.socket = new net.Socket()
		self.socket.setNoDelay(true)

		self.socket.on('error', function (err) {
			debug('Network error', err)
			self.status(self.STATE_ERROR, err)
			self.log('error', 'Network error: ' + err.message)
			self.connected = false
			self.connecting = false
			delete self.socket
		})

		self.socket.on('connect', function () {
			receivebuffer = ''
			self.connect_time = Date.now()

			if (self.currentStatus != self.STATUS_OK) {
				self.status(self.STATUS_OK, 'Connected')
				debug('Connected to projector')
			}

			self.connected = true
		})

		self.socket.on('end', function () {
			self.connected = false
			self.connecting = false
			debug('Disconnected')
		})

		self.socket.on('data', function (chunk) {
			// separate buffered stream into lines with responses
			var i = 0,
				line = '',
				offset = 0
			receivebuffer += chunk
			while ((i = receivebuffer.indexOf('\r', offset)) !== -1) {
				line = receivebuffer.substr(offset, i - offset)
				offset = i + 1
				self.socket.emit('receiveline', line.toString())
			}
			receivebuffer = receivebuffer.substr(offset)
		})

		self.socket.on('receiveline', function (data) {
			self.connect_time = Date.now()

			debug('PJLINK: < ' + data)

			if (data.match(/^PJLINK ERRA/)) {
				debug('Password not accepted')
				self.log('error', 'Authentication error. Password not accepted by projector')
				self.commands.length = 0
				self.status(self.STATUS_ERROR, 'Authentication error')
				self.connected = false
				self.connecting = false
				self.socket.destroy()
				delete self.socket
				return
			}

			if (data.match(/^PJLINK 0/)) {
				debug('Projector does not need password')
				self.passwordstring = ''

				// no auth
				if (typeof cb == 'function') {
					cb()
				}
			}

			var match
			if ((match = data.match(/^PJLINK 1 (\S+)/))) {
				var digest = match[1] + self.config.password
				var hasher = crypto.createHash('md5')
				var hex = hasher.update(digest, 'utf-8').digest('hex')
				// transmit the authentication hash and a pjlink command
				self.socket.write(hex + '%1POWR ?\r')

				// Shoot and forget, by protocol definition :/
				if (typeof cb == 'function') {
					cb()
				}
			}

			if ((match = data.match(/^%1([a-zA-Z]{4})=OK$/))) {
				//Command Accepted
			} else if ((match = data.match(/^%1([a-zA-Z]{4})=ERR.*$/))) {
				self.log('error', 'Command Error: ' + match[0])
			} else if ((match = data.match(/^(%[1-2][a-zA-Z]{4})=(.*)$/))) {
				self.setLocalVariable(match[1], match[2])
			}

			if (self.commands.length) {
				var cmd = self.commands.shift()

				self.socket.write(self.passwordstring + cmd + '\r')
			} else {
				clearInterval(self.socketTimer)

				self.socketTimer = setInterval(function () {
					if (self.commands.length > 0) {
						var cmd = self.commands.shift()
						self.connect_time = Date.now()
						self.socket.write(self.passwordstring + cmd + '\r')
						clearInterval(self.socketTimer)
						delete self.socketTimer
					}

					if (Date.now() - self.connect_time > 1000) {
						self.getVariables()
						self.checkFeedbacks()
					}
					if (Date.now() - self.connect_time > 4000) {
						if (self.socket !== undefined && self.socket.destroy !== undefined) {
							self.socket.destroy()
						}

						delete self.socket
						self.connected = false
						self.connecting = false

						if (self.socketTimer) {
							clearInterval(self.socketTimer)
							delete self.socketTimer
						}

						debug('disconnecting per protocol defintion :(')
					}
				}, 100)
			}
		})

		self.socket.connect(4352, self.config.host)
	}
}

instance.prototype.send = function (cmd) {
	var self = this

	if (self.connecting) {
		self.commands.push(cmd)
	} else {
		self.init_tcp(function () {
			self.connect_time = Date.now()

			self.socket.write(self.passwordstring + cmd + '\r')
		})
	}
}

// Return config fields for web config
instance.prototype.config_fields = function () {
	var self = this
	return [
		{
			type: 'textinput',
			id: 'host',
			label: 'Target IP',
			width: 6,
			regex: self.REGEX_IP,
		},
		{
			type: 'textinput',
			id: 'password',
			label: 'PJLink password (empty for none)',
			width: 6,
		},
	]
}

// When module gets deleted
instance.prototype.destroy = function () {
	var self = this

	if (self.socket !== undefined) {
		self.socket.destroy()
		delete self.socket
	}
}

instance.prototype.actions = function (system) {
	var self = this

	self.system.emit('instance_actions', self.id, {
		powerOn: { label: 'Power On Projector' },
		powerOff: { label: 'Power Off Projector' },
		togglePower: { label: 'Toggle Projector Power' },
		shutterOpen: { label: 'Open Shutter' },
		shutterClose: { label: 'Close Shutter' },
		freeze: { label: 'Freeze Input' },
		unfreeze: { label: 'Unfreeze Input' },
		inputToggle: {
			label: 'Switch Input',
			options: [
				{
					type: 'dropdown',
					label: 'Select input',
					id: 'inputNum',
					default: '31',
					choices: [
						{ id: '11', label: 'RGB1' },
						{ id: '12', label: 'RGB2' },
						{ id: '31', label: 'DVI-D' },
						{ id: '32', label: 'HDMI' },
						{ id: '33', label: 'Digital link' },
						{ id: '34', label: 'SDI1' },
						{ id: '35', label: 'SDI2' },
					],
				},
			],
		},
	})
}

instance.prototype.action = function (action) {
	var self = this
	var id = action.action
	var opt = action.options
	var cmd

	switch (action.action) {
		case 'powerOn':
			cmd = '%1POWR 1'
			break

		case 'powerOff':
			cmd = '%1POWR 0'
			break

		case 'togglePower':
			if (self.variables['%1POWR'] == 1) {
				cmd = '%1POWR 0'
			} else if (self.variables['%1POWR'] == 0) {
				cmd = '%1POWR 1'
			}
			break

		case 'shutterOpen':
			cmd = '%1AVMT 30'
			break

		case 'shutterClose':
			cmd = '%1AVMT 31'
			break

		case 'freeze':
			cmd = '%2FREZ 1'
			break

		case 'unfreeze':
			cmd = '%2FREZ 0'
			break

		case 'inputToggle':
			cmd = '%1INPT ' + opt.inputNum
			break
	}

	if (cmd !== undefined) {
		debug('sending ', cmd, 'to', self.config.host)

		self.send(cmd)
	}

	// debug('action():', action);
}

instance.prototype.initPresets = function () {
	var self = this
	var presets = []

	presets.push({
		category: 'Commands',
		label: 'Power Toggle',
		bank: {
			style: 'text',
			text: 'Power Toggle',
			size: '18',
			color: this.rgb(255, 255, 255),
			bgcolor: this.rgb(0, 0, 0),
		},
		feedbacks: [
			{
				type: 'POWR',
				options: {
					bg_on: this.rgb(0, 255, 0),
					fg_on: this.rgb(0, 0, 0),
					bg_warming: this.rgb(255, 255, 0),
					fg_warming: this.rgb(0, 0, 0),
					bg_cooling: this.rgb(0, 255, 255),
					fg_cooling: this.rgb(0, 0, 0),
					bg_off: this.rgb(0, 0, 0),
					fg_off: this.rgb(255, 255, 255),
				},
			},
		],
		actions: [{ action: 'togglePower' }],
	})
	this.setPresetDefinitions(presets)
}

instance.prototype.setLocalVariable = function (name, value) {
	var self = this
	// var changed = this.variables[name] !== value;
	self.variables[name] = value
	self.setVariable(name, value)
	if (name === '%1CLSS') {
		self.initClass2Variables()
		self.getStaticClass2Variables()
	}
}

instance.prototype.initVariables = function () {
	var self = this
	const variables = []

	variables.push({ label: 'Power status', name: '%1POWR' })
	self.setLocalVariable('%1POWR', undefined)
	variables.push({ label: 'Input switch', name: '%1INPT' })
	self.setLocalVariable('%1INPT', undefined)
	variables.push({ label: 'Mute Status', name: '%1AVMT' })
	self.setLocalVariable('%1AVMT', undefined)
	variables.push({ label: 'Error Status', name: '%1ERST' })
	self.setLocalVariable('%1ERST', undefined)
	variables.push({ label: 'Lamp Hours', name: '%1LAMP' })
	self.setLocalVariable('%1LAMP', undefined)
	variables.push({ label: 'Input List', name: '%1INST' })
	self.setLocalVariable('%1INST', undefined)
	variables.push({ label: 'Projector Name', name: '%1NAME' })
	self.setLocalVariable('%1NAME', undefined)
	variables.push({ label: 'Manufacturer Name', name: '%1INF1' })
	self.setLocalVariable('%1INF1', undefined)
	variables.push({ label: 'Product Name', name: '%1INF2' })
	self.setLocalVariable('%1INF2', undefined)
	variables.push({ label: 'Other Info', name: '%1INFO' })
	self.setLocalVariable('%1INFO', undefined)
	variables.push({ label: 'Class Info', name: '%1CLSS' })
	self.setLocalVariable('%1CLSS', undefined)

	self.setVariableDefinitions(variables)
}

instance.prototype.initClass2Variables = function () {
	var self = this
	const variables = []

	variables.push({ label: 'Power status', name: '%1POWR' })
	variables.push({ label: 'Input switch', name: '%1INPT' })
	variables.push({ label: 'Mute Status', name: '%1AVMT' })
	variables.push({ label: 'Error Status', name: '%1ERST' })
	variables.push({ label: 'Lamp Hours', name: '%1LAMP' })
	variables.push({ label: 'Input List', name: '%1INST' })
	variables.push({ label: 'Projector Name', name: '%1NAME' })
	variables.push({ label: 'Manufacturer Name', name: '%1INF1' })
	variables.push({ label: 'Product Name', name: '%1INF2' })
	variables.push({ label: 'Other Info', name: '%1INFO' })
	variables.push({ label: 'Class Info', name: '%1CLSS' })
	variables.push({ label: 'Serial Number', name: '%2SNUM' })
	self.setLocalVariable('%2SNUM', undefined)
	variables.push({ label: 'Software Version', name: '%2SVER' })
	self.setLocalVariable('%2SVER', undefined)
	variables.push({ label: 'Input Terminal Name', name: '%2INNM' })
	self.setLocalVariable('%2INNM', undefined)
	variables.push({ label: 'Input Resolution', name: '%2IRES' })
	self.setLocalVariable('%2IRES', undefined)
	variables.push({ label: 'Recommend Resolution', name: '%2RRES' })
	self.setLocalVariable('%2RRES', undefined)
	variables.push({ label: 'Filter Usage Time', name: '%2FILT' })
	self.setLocalVariable('%2FILT', undefined)
	variables.push({ label: 'Lamp Model Number', name: '%2RLMP' })
	self.setLocalVariable('%2RLMP', undefined)
	variables.push({ label: 'Filter Model Number', name: '%2RFIL' })
	self.setLocalVariable('%2RFIL', undefined)
	variables.push({ label: 'Freeze Status', name: '%2FREZ' })
	self.setLocalVariable('%2FREZ', undefined)

	self.setVariableDefinitions(variables)
}

instance.prototype.getStaticVariables = function () {
	var self = this
	self.send('%1NAME ?')
	self.send('%1INST ?')
	self.send('%1INF1 ?')
	self.send('%1INF2 ?')
	self.send('%1INFO ?')
	self.send('%1CLSS ?')
}

instance.prototype.getStaticClass2Variables = function () {
	var self = this
	self.send('%2SNUM ?')
	self.send('%2SVER ?')
	self.send('%2RRES ?')
	self.send('%2RLMP ?')
	self.send('%2RFIL ?')
}

instance.prototype.getVariables = function () {
	var self = this
	self.send('%1POWR ?')
	self.send('%1INPT ?')
	self.send('%1AVMT ?')
	self.send('%1ERST ?')
	self.send('%1LAMP ?')
	if (self.variables['%1CLSS'] > 1) {
		self.send('%2INNM ?' + self.variables['%1INPT'])
		self.send('%2IRES ?')
		self.send('%2FILT ?')
		self.send('%2FREZ ?')
	}
}

instance.prototype.initFeedbacks = function () {
	var self = this
	const feedbacks = {}
	feedbacks['POWR'] = {
		label: 'Power status',
		description: 'Change background color of the bank based on power status',
		options: [
			{
				type: 'colorpicker',
				label: 'Foreground color (On)',
				id: 'fg_on',
				default: self.rgb(0, 0, 0),
			},
			{
				type: 'colorpicker',
				label: 'Background color (On)',
				id: 'bg_on',
				default: self.rgb(0, 255, 0),
			},
			{
				type: 'colorpicker',
				label: 'Foreground color (Warmin)',
				id: 'fg_warming',
				default: self.rgb(0, 0, 0),
			},
			{
				type: 'colorpicker',
				label: 'Background color (Warming)',
				id: 'bg_warming',
				default: self.rgb(255, 255, 0),
			},
			{
				type: 'colorpicker',
				label: 'Foreground color (Cooling)',
				id: 'fg_cooling',
				default: self.rgb(0, 0, 0),
			},
			{
				type: 'colorpicker',
				label: 'Background color (Cooling)',
				id: 'bg_cooling',
				default: self.rgb(0, 255, 255),
			},
			{
				type: 'colorpicker',
				label: 'Foreground color (Off)',
				id: 'fg_off',
				default: self.rgb(255, 255, 255),
			},
			{
				type: 'colorpicker',
				label: 'Background color (Off)',
				id: 'bg_off',
				default: self.rgb(0, 0, 0),
			},
		],
		callback: function (feedback) {
			switch (self.variables['%1POWR']) {
				case '0':
					return { bgcolor: feedback.options.bg_off, color: feedback.options.fg_off }
					break
				case '1':
					return { bgcolor: feedback.options.bg_on, color: feedback.options.fg_on }
					break
				case '2':
					return { bgcolor: feedback.options.bg_cooling, color: feedback.options.fg_cooling }
					break
				case '3':
					return { bgcolor: feedback.options.bg_warming, color: feedback.options.fg_warming }
					break
				default:
					return
					break
			}
		},
	}
	self.setFeedbackDefinitions(feedbacks)
}

instance_skel.extendedBy(instance)
exports = module.exports = instance
