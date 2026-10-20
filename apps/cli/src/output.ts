import pc from 'picocolors';
import Table from 'cli-table3';

export interface CliLogger {
  log(message?: any, ...optionalParams: any[]): void;
  error(message?: any, ...optionalParams: any[]): void;
  warn(message?: any, ...optionalParams: any[]): void;
  info(message?: any, ...optionalParams: any[]): void;
  json(data: any): void;
  isJson: boolean;
}

export function createLogger(isJson: boolean = false, customOut?: (msg: string) => void, customErr?: (msg: string) => void): CliLogger {
  const outFn = customOut || ((msg: string) => console.log(msg));
  const errFn = customErr || ((msg: string) => console.error(msg));

  return {
    isJson,
    log(...args: any[]) {
      if (!isJson) {
        outFn(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
      }
    },
    error(...args: any[]) {
      if (!isJson) {
        errFn(pc.red(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')));
      }
    },
    warn(...args: any[]) {
      if (!isJson) {
        outFn(pc.yellow(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')));
      }
    },
    info(...args: any[]) {
      if (!isJson) {
        outFn(pc.cyan(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')));
      }
    },
    json(data: any) {
      outFn(JSON.stringify(data, null, 2));
    }
  };
}

export function createTable(options: any): Table.Table {
  return new Table(options);
}

export { pc };
