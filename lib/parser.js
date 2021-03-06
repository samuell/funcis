var _ = require('lodash')
	, Lexer = require('./lexer')
	, sd = require('./scriptdata')
	, Func = sd.Func
	, Expr = sd.Expr
	, Script = sd.Script;

var Parser = module.exports = function (str) {
	this.input = str;
	this.lexer = new Lexer(str);
	this.funcs = [];
}

Parser.prototype = {
	advance: function () {
		return this.lexer.advance();
	},

	peek: function () {
		return this.lexer.lookahead(1);
	},

	parseConst: function () {
		var name = this.advance()
			, param = this.advance();
		return { name: name.val, expr: new Expr(param.val, param.subtype) };
	},

	parseCont: function () {
		var tok = this.advance()
			, fn = new Func(null, tok.val, [], this.parseParams());
		var clear = true;
		while (clear) {
			switch (this.peek().type) {
				case 'callback':
				case 'indent':
				case 'outdent':
				case 'comment':
				case 'newline':
					this.advance();
					continue;
				default:
					clear = false;
					break;
			}
		}
		while(this.peek().indent > tok.indent) {
			fn.callbacks.push(this.parseFunc());
		}
		return fn;
	},

	parseFunc: function () {
		var selector 
			, name 
			, fn;

		while (this.peek().type !== 'selector' && this.peek().type !== 'func') {
			this.advance();
			if (!this.peek() || this.peek().type === 'eos') {
				throw new Error('Unexpected end of source');
			}
		}

		if (this.peek().type === 'selector') {
			selector = this.advance();
		}
		if (this.peek().type === 'func') {
			name = this.advance();
		}

		fn = new Func(selector ? selector.val : null, name.val, this.parseParams(), this.parseParams());
		var clear = true;
		while (clear) {
			switch (this.peek().type) {
				case 'callback':
				case 'indent':
				case 'outdent':
				case 'comment':
				case 'newline':
					this.advance();
					continue;
				default:
					clear = false;
					break;
			}
		}
		while(this.peek().indent > (selector ? selector : name).indent) {
			fn.callbacks.push(this.parseFunc());
		}
		return fn;
	},

	parseParams: function () {
		var tok
			, params = [];
		var clear = true;
		while (clear) {
			switch (this.peek().type) {
				case 'callback':
				case 'indent':
				case 'outdent':
				case 'comment':
				case 'newline':
					this.advance();
					continue;
				default:
					clear = false;
					break;
			}
		}
		if (this.peek().type !== 'params')
			return [];
		else
			this.advance();
		while (this.peek().type === 'param') {
			tok = this.advance();
			var val = tok.val;
			if (tok.subtype === 'json' || tok.subtype === 'array') {
				val = val.replace(/( *{ *| *, *)\'?(\w+)\'? *: */g, "$1\"$2\": ");
			}
			params.push(new Expr(val, tok.subtype));
		}
		if (this.advance().type !== 'paramStop')
			throw new Error('Params missing end');
		return params;
	},
	
	parse: function () {
		var constants = {} 
			, continuations = {}
			, functions = []
			, currentFunc = null;
		while (this.peek().type !== 'eos') {
			switch (this.peek().type) {
				case 'const':
					var cn = this.parseConst();
					if (constants[cn.name])
						throw new Error('Duplicate name of a constant');
					constants[cn.name] = cn.expr;
					continue;
				case 'cont':
					var cn = this.parseCont();
					if (continuations[cn.name])
						throw new Error('Duplicate name of a continuation');
					continuations[cn.name] = cn;
					continue;
				case 'selector':
					if (this.peek().indent > 0) 
						throw new Error('Top level functions must not be indented');
					var fn = this.parseFunc();
					functions.push(fn);
					continue;
				case 'func':
				case 'params':
				case 'paramStop':
					throw new Error('Syntax error');
				default:
					//Do nothing with this token;
					this.advance();
					continue;
			}
		}
		return this.optimize(this.validate(new Script(constants, continuations, functions)));
	}, 

	optimize: function (data) {
		for (var i in data.continuations) {
			var f = data.continuations[i];
			f.passalongs = this.getPassalongs(f);
		}
		for (var i in data.functions) {
			var f = data.functions[i];
			f.passalongs = this.getPassalongs(f);
		}
		return data;
	},

	getPassalongs: function (f) {
		var self = this
			, re = /:\s*([A-Za-z]\w*)(.[^,\s\}]*)?\s*/g;
		var ins = _(f.callbacks)
			.map(function (e) { 
				e.passalongs = self.getPassalongs(e);
				return _(e.input)
					.map(function (e) {
						if (e.type === 'arg') {
							return self.resolveArg(e);
						}
						if (e.type === 'json' || e.type === 'array') {
							var cap
								, str = e.val
								, vals = [];
							while (cap = re.exec(str)) {
								vals.push(cap[1]);
							}
							return vals;
						}
						return [];
					})
					.flatten()
					.union(e.passalongs)
					.value();
			})
			.flatten()
			.uniq()
			.value();
		return ins;
	},

	resolveJSON: function (str, stack) {
		var re = /:\s*([A-Za-z]\w*)(.[^,\s\}]*)?\s*/
			, cap;
		while (cap = re.exec(str)) {
			if (!stack[cap[1]]) {
				throw new Error('Unresolved function input parameter "' + cap[1] + '"');
			}
			str = str.replace(re, ': ' + stack[cap[1]]);
		}
		return str;
	},

	buildStack: function (f, sk) {
		var stack = _.clone(sk);
		for (var i in f.output) {
			var p = f.output[i];
			if (p.type !== 'arg') {
				throw new Error('Can not have a constant as a output parameter');
			}
			if (p.val === '_') {
				continue;
			}
			stack[p.val] = 1;
		}
		return stack;
	},

	validateCont: function (cont, data) {
		var stack = this.buildStack(cont, data.constants);
		for (var i in cont.callbacks) {
			this.validateFunc(cont.callbacks[i], stack, data);
		}
	},

	resolveArg: function (p, stack) {
		var re = /^([^]+?)\./.exec(p.val)
			, name = re ? re[1] : p.val;
		return name;
	},

	validateFunc: function (f, sk, data) {
		var sk = data === null ? sk.constants : sk;
		if (!f.selector && !data.continuations[f.name]) {
				throw new Error('Unresolved continuation "' + f.name + '"');
		}
		for (var i in f.input) {
			var p = f.input[i];
			if (p.type === 'arg') {
				var name = this.resolveArg(p, sk);
				if (!sk[name]) {
					throw new Error('Unresolved function input parameter "' + name + '"');
				}
			}
			else if (p.type === 'json' || p.type === 'array') {
				try {
					var str = this.resolveJSON(p.val, sk);
					var obj = JSON.parse(str);
				} catch (e) {
					throw new Error('Constant parameter is malformed: ' + e);
				}
			}
		}
		var stack = this.buildStack(f, sk);
		for (var i in f.callbacks) {
			this.validateFunc(f.callbacks[i], stack, data);
		}
	},

	validate: function (data) {
		for (var i in data.continuations) {
			this.validateCont(data.continuations[i], data);
		}
		for (var i in data.functions) {
			this.validateCont(data.functions[i], data);
		}
		return data;
	}
}
