const os = require('os');
const {cfg, Connect} = require('sm-utils');
const startCase = require('lodash/startCase');

const Notify = require('./Notify');
const {getPackageInfo, getLogger} = require('./helpers');

const DEFAULT_CHANNEL = 'default';
const DEFAULT_WEBHOOK_NAME = 'default';

/**
 * @typedef {import('@smpx/notify').TeamsTypes.Section} Section
 * @typedef {import('@smpx/notify').TeamsTypes.Action} Action
 * @typedef {import('@smpx/notify').TeamsTypes.MessageCard} MessageCard
 */

/** 
 * @param {string} [channel] `<channelName>[.<webhookName>]`
 * @returns {string}
 */
function getTeamsWebhookUrl(channel = Teams.defaultChannel) {
	if (!channel.includes('.')) channel += `.${DEFAULT_WEBHOOK_NAME}`;
	// @ts-ignore
	return cfg(`teams.${channel}`);
}

/**
 * @returns {Section[]}
 */
function getDefaultAttachments() {
	const {name, version} = getPackageInfo();
	const facts = [
		{
			name: 'Hostname',
			value: os.hostname(),
		},
		{
			name: 'Node Environment',
			value: cfg.getEnv(),
		},
	];

	let footerSuffix = '';
	if (process.env.name || process.env.pm_id) {
		footerSuffix = `| ${process.env.name} ${process.env.pm_id || -1}`
	}

	return [{
		activityTitle: 'App Info:',
		activitySubtitle: `${name} v${version} ${footerSuffix} | ${new Date().toLocaleString()}`,
		facts,
	}];
}

class Teams extends Notify {
	/**
	 * Overwrite this function to skip teams message sending in some cnditions
	 * and log the message instead. By default skips in test environment
	 */
	static logCondition() {
		return cfg.isTest();
	}

	/** @param {{text?: string, channel?: string}} opts */
	constructor({text, channel} = {}) {
		super();

		this._themeColor = '439FE0'; // blue
		/** @type {Section[]} */
		this._sections = [];
		/** @type {Error[]} */
		this._errors = [];
		/** @type {Action[]} */
		this._actions = [];

		if (channel) this.channel(channel);
		if (text) this.text(text);
	}

	/** @param {string} channel */
	static set defaultChannel(channel) {
		this._defaultChannel = channel;
	}

	/** @returns {string} */
	static get defaultChannel() {
		return this._defaultChannel || DEFAULT_CHANNEL;
	}

	/** [Dummy] Teams does not support username */
	username() { return this }
	/** [Dummy] Teams does not support icon */
	icon() { return this }

	/** @param {string} channel */
	channel(channel) {
		this._channel = channel;
		return this;
	}

	/** @param {string} summary */
	summary(summary) {
		this._summary = summary;
		return this;
	}

	/** @param {string} color */
	color(color) {
		this._themeColor = color.replace('#', '');
		return this;
	}

	/** @param {string} title */
	title(title) {
		this._title = title;
		return this;
	}

	/** @param {string} text */
	text(text) {
		this._text = Teams.escapeText(text);
		return this;
	}

	/** @param {Section | Section[]} sections */
	attachment(sections) {
		if (!Array.isArray(sections)) sections = [sections];
		sections = sections.map((section) => {
			if (section.text) section.text = Teams.escapeText(section.text);
			return section;
		});
		this._sections = this._sections.concat(sections);
		return this;
	}

	/** @param {Action | Action[]} actions */
	action(actions) {
		if (!Array.isArray(actions)) actions = [actions];
		this._actions = this._actions.concat(actions);
		return this;
	}

	/**
	 * Create a MessageBox
	 * @param {Error} err
	 * @param {{label?: string, title?: string}} [param1={}]
	 */
	error(err, {label = '', title = ''} = {}) {
		this._errors.push(err);
		const {bugs, version} = getPackageInfo();
		const bugsUrl = bugs && bugs.url;

		err.stack = err.stack.replace(/ /g, '&nbsp;');
		label = `[${label || err.name}] `;

		this.color('F00'); // Red
		this.title(`Error: ${err.message}`);
		this.text(err.stack);
		this.button(
			'Create an issue for this error?',
			`${bugsUrl}/new?title=${
				encodeURIComponent(`${label}${title || err.message}`)
			}&body=${encodeURIComponent(
				`Error encountered on ${new Date().toLocaleString()}\n` +
				`App version: v${version}\n\n` +
				`Full Stack: ${err.stack}`
			)}&labels=bug`
		);
		return this;
	}

	/**
	 * Add a section with facts
	 * @param {string} title
	 * @param {{[statTitle: string]: string | number | boolean | object}} keyValues
	 * @param {{ignoreUndefined?: boolean}} opts
	 */
	stats(title, keyValues, {ignoreUndefined = true} = {}) {
		/** @type {Section} */
		const section = {
			title,
			facts: [],
		};

		Object.keys(keyValues).forEach((key) => {
			let value = keyValues[key];

			if(ignoreUndefined && value === undefined) return;

			if (['boolean', 'number', 'undefined'].includes(typeof value)) value = String(value);
			else if (typeof value !== 'string') value = String(JSON.stringify(value));
			value = Teams.escapeText(value.trim());

			section.facts.push({
				name: startCase(key.trim()),
				value,
			});
		})

		return this.attachment(section);
	}

	/**
	 * @param {string} name
	 * @param {string} uri
	 */
	button(name, uri) {
		/** @type {Action} */
		const button = {
			"@type": 'OpenUri',
			name,
			targets: [{
				os: 'default',
				uri,
			}],
		};
		return this.action(button);
	}

	/**
	 * @param {{defaultAttachment?: boolean}} opts
	 */
	async send({defaultAttachment = true} = {}) {
		if (!this._summary && !this._text) throw new Error('Either summary or text is required');

		/** @type {MessageCard} */
		const message = {
			summary: this._summary,
			themeColor: this._themeColor,
			title: this._title,
			text: this._text,
			sections: this._sections,
			potentialAction: this._actions,
		}

		return Teams.postMessage(message, {channel: this._channel, defaultAttachment});
	}

	/**
	 * @param {MessageCard} message 
	 * @param {object} [opts]
	 * @param {string} [opts.channel]
	 * @param {boolean} [opts.defaultAttachment=true]
	 */
	static async postMessage(message, {channel, defaultAttachment = true} = {}) {
		// Do not modify original message;
		message = Object.assign({}, message);

		message.sections = message.sections || [];
		if (defaultAttachment) message.sections = message.sections.concat(getDefaultAttachments());

		if (this.logCondition()) {
			getLogger().info({label: 'Teams', ...message}, 'Teams message');
			return;
		}

		const webhookUrl = getTeamsWebhookUrl(channel);
		if (!webhookUrl) throw new Error(`No webhook url for channel: "${channel}"`)

		return this._postMessage(webhookUrl, message);
	}

	static bold(txt) {
		return `**${txt}**`;
	}

	static italics(txt) {
		return `*${txt}*`;
	}

	static strikethrough(txt) {
		return `~~${txt}~~`;
	}

	/**
	 * @param {string} url
	 * @param {string} text
	 */
	static formatUrl(url, text) {
		return `[${text}](${url})`;
	}

	/**
	 * Replace `\n` with `3 spaces + \n`
	 * @see https://stackoverflow.com/questions/52637567/how-to-insert-newline-into-ms-teams-markdown
	 * @param {string} text
	 */
	static escapeText(text) {
		if (!text) return text;
		return text.replace(/(\n*)/g, (_, lineBreaks) => {
			if (!lineBreaks.length) return lineBreaks;
			let ret = '';
			for (let i = 0; i < lineBreaks.length - 1; i++) ret += '   \n&nbsp;';
			return ret + '   \n';
		});
	}

	/**
	 * @param {string} webhookUrl
	 * @param {string} [channel] default: `Teams.defaultChannel`
	 */
	static setWebhook(webhookUrl, channel = Teams.defaultChannel) {
		if (!channel.includes('.')) channel += `.${DEFAULT_WEBHOOK_NAME}`;
		cfg.set(`teams.${channel}`, webhookUrl);
	}

	/** [Dummy] */
	static setToken() {}
}

module.exports = Teams;
