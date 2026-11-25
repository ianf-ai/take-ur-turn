/** Read-only services; session selection and verification stay in native contracts. */
export interface SessionReadServices {
 nativeSessionBase?:string;
 home?:string;env?:Record<string,string|undefined>;
 entries(directory:string):Promise<string[]>;
 readHead(file:string,maxBytes:number):Promise<string|undefined>;
 realpath?(directory:string):Promise<string>;
}
