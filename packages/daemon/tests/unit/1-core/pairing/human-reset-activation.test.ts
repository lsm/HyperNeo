import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHumanDeviceResetOperation, onHumanDevicesReset } from '../../../../src/lib/pairing/human-device-reset';
import { onDeviceRevoked } from '../../../../src/lib/pairing/upgrade-auth';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRegistry, type OperationCaller } from '../../../../src/lib/operations/registry';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import type { DbOp } from '../../../../src/storage/db-gateway/db-op';
import { humanDeviceResetReads } from '../../../../src/storage/repositories/human-device-reset-read';
import { humanDeviceResetWrites } from '../../../../src/storage/repositories/human-device-reset-write';
import { DevicePairingRepository } from '../../../../src/storage/repositories/device-pairing-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { Database } from '../../../../src/storage/sqlite-compat';

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
class FaultGateway extends DbGateway {
  writes = 0;
  reads = 0;
  activeReads = 0;
  maxActiveReads = 0;
  failWrite = false;
  loseReply = false;
  failedReads = false;
  holdRead: Promise<void> | undefined;
  override async run<A, R>(op: DbOp<A, R>, args: A): Promise<R> {
    if (op.name === humanDeviceResetWrites.name) {
      this.writes++;
      if (this.failWrite) throw new Error('synthetic admission rejected');
      const result = await super.run(op, args);
      if (this.loseReply) throw new Error('synthetic committed reply lost; outcome unknown');
      return result;
    }
    if (op.name === humanDeviceResetReads.name) {
      this.reads++;
      this.activeReads++;
      this.maxActiveReads = Math.max(this.maxActiveReads, this.activeReads);
      try {
        if (this.failedReads) throw new Error('synthetic reader unavailable');
        await this.holdRead;
        return await super.run(op, args);
      } finally {
        this.activeReads--;
      }
    }
    return super.run(op, args);
  }
}

describe('public human reset DB worker activation', () => {
  let main: Database;
  let writer: Database;
  let gateway: FaultGateway;
  let repo: DevicePairingRepository;
  let registry: ReturnType<typeof createOperationRegistry>;
  let revoked: string[];
  let publications: string[];
  let offs: (()=>void)[];
  let mainSql: number;
  const now=Date.now();
  const door: OperationCaller = { source:'mcp', principal:'session-door', sessionId:'cli' };
  beforeEach(()=>{
    main=new Database(':memory:'); writer=new Database(':memory:');
    runMigrations(writer,()=>{}); createTables(writer);
    gateway=new FaultGateway(':memory:',writer); bindGateway(main,gateway);
    repo=new DevicePairingRepository(writer); revoked=[]; publications=[]; mainSql=0;
    main.prepare=()=>{ mainSql++; throw new Error('human-reset SQL reached main'); };
    registry=createOperationRegistry([createHumanDeviceResetOperation(()=>main)]);
    offs=[onDeviceRevoked(id=>{expect(repo.isActiveDevice(id)).toBe(false);revoked.push(id);}),onHumanDevicesReset(id=>publications.push(id))];
  });
  afterEach(async()=>{await gateway.close();for(const off of offs)off();main.close();writer.close();});
  const pair=()=>{const code=repo.createCode('human','Synthetic phone',true,now);return repo.redeem(code.code,'Synthetic phone',now)!;};
  const reset=(caller=door)=>invokeOperation(registry,'device.reset_human',{},caller);
  const wait=async(predicate:()=>boolean)=>{const until=Date.now()+3500;while(!predicate()){if(Date.now()>until)throw new Error('public reset notification deadline exceeded');await pause(5);}};

  test('local reset preserves its public reply and announces only committed state without main SQL',async()=>{
    const phone=pair();
    expect(await reset()).toEqual({kind:'completed',value:{ok:true,resetAt:expect.any(Number),devices:[{id:phone.device.id,name:phone.device.name}]}});
    expect(revoked).toEqual([phone.device.id]);expect(publications).toHaveLength(1);expect(gateway.writes).toBe(1);expect(mainSql).toBe(0);
    const row=writer.prepare('SELECT id FROM human_device_resets').get() as {id:string};
    expect(await gateway.call(humanDeviceResetReads,'receipt',row.id)).toMatchObject({conversationId:publications[0],devices:[{id:phone.device.id,name:phone.device.name}]});
  });

  test('network and agent callers stay refused without DB admission or notifications',async()=>{
    const phone=pair();
    for(const caller of [{source:'rpc',principal:'local'},{source:'rpc',principal:'local',device:{deviceId:phone.device.id,kind:'human'}},{source:'mcp',role:'neo',sessionId:'neo:synthetic'}] as OperationCaller[])
      expect(await reset(caller)).toMatchObject({kind:'completed',value:{ok:false,reason:expect.stringContaining('local_cli_only:')}});
    expect(repo.isActiveDevice(phone.device.id)).toBe(true);expect(gateway.writes).toBe(0);expect(revoked).toEqual([]);expect(publications).toEqual([]);expect(mainSql).toBe(0);
  });

  test('a lost reply releases the caller but later publishes the exact committed reset without replay',async()=>{
    const phone=pair();gateway.loseReply=true;gateway.failedReads=true;
    expect(await reset()).toMatchObject({kind:'failed',message:expect.stringContaining('outcome unknown')});
    await pause(1200);expect(revoked).toEqual([]);expect(publications).toEqual([]);expect(repo.isActiveDevice(phone.device.id)).toBe(false);
    gateway.failedReads=false;await wait(()=>publications.length===1);
    expect(revoked).toEqual([phone.device.id]);expect(gateway.writes).toBe(1);expect(mainSql).toBe(0);
  });

  test('a second-notice failure rolls back humans and codes and never notifies',async()=>{
    const phones=Array.from({length:21},pair);const code=repo.createCode('human',null,true,now);
    writer.exec("CREATE TRIGGER reject_second_notice BEFORE INSERT ON neo_publications WHEN json_extract(NEW.payload_json, '$.fullText') LIKE '%(part 2)%' BEGIN SELECT RAISE(ABORT, 'synthetic second notice failure'); END");
    expect(await reset()).toMatchObject({kind:'failed',message:expect.stringContaining('synthetic second notice failure')});
    expect(phones.every(p=>repo.isActiveDevice(p.device.id))).toBe(true);expect(repo.redeem(code.code,'Still valid',now)).not.toBeNull();
    expect(writer.prepare('SELECT COUNT(*) AS count FROM human_device_resets').get()).toEqual({count:0});
    expect(writer.prepare('SELECT COUNT(*) AS count FROM neo_publications').get()).toEqual({count:0});
    expect(revoked).toEqual([]);expect(publications).toEqual([]);expect(mainSql).toBe(0);
  });

  test('failed admission cannot borrow a later reset receipt to send an extra notification',async()=>{
    const phone=pair();gateway.failWrite=true;
    expect(await reset()).toMatchObject({kind:'failed',message:expect.stringContaining('admission rejected')});
    expect(repo.isActiveDevice(phone.device.id)).toBe(true);expect(revoked).toEqual([]);expect(publications).toEqual([]);
    gateway.failWrite=false;
    expect(await reset()).toMatchObject({kind:'completed',value:{ok:true}});await pause(1100);
    expect(revoked).toEqual([phone.device.id]);expect(publications).toHaveLength(1);expect(gateway.writes).toBe(2);expect(mainSql).toBe(0);
  });

  test('gateway close cancels uncertain notification recovery without new SQL or callbacks',async()=>{
    pair();gateway.loseReply=true;gateway.failedReads=true;
    expect(await reset()).toMatchObject({kind:'failed',message:expect.stringContaining('outcome unknown')});
    await wait(()=>gateway.reads>0);await gateway.close();const reads=gateway.reads;await pause(1100);
    expect(gateway.reads).toBe(reads);expect(revoked).toEqual([]);expect(publications).toEqual([]);expect(gateway.writes).toBe(1);expect(mainSql).toBe(0);
  });
});
