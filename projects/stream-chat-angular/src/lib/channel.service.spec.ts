import { fakeAsync, TestBed, tick } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { first, take } from 'rxjs/operators';
import {
  Channel,
  ChannelMemberResponse,
  ChannelOptions,
  ChannelResponse,
  ChannelSort,
  Event,
  SendMessageAPIResponse,
  UserResponse,
} from 'stream-chat';
import { ChannelService } from './channel.service';
import { ChatClientService, ClientEvent } from './chat-client.service';
import {
  generateMockChannels,
  generateMockMessages,
  MockChannel,
  mockCurrentUser,
  mockMessage,
} from './mocks';
import { NotificationService } from './notification.service';
import {
  AttachmentUpload,
  DefaultStreamChatGenerics,
  StreamMessage,
} from './types';

describe('ChannelService', () => {
  let service: ChannelService;
  let mockChatClient: {
    queryChannels: jasmine.Spy;
    channel: jasmine.Spy;
    updateMessage: jasmine.Spy;
    deleteMessage: jasmine.Spy;
    userID: string;
    pinMessage: jasmine.Spy;
    unpinMessage: jasmine.Spy;
    activeChannels: { [key: string]: Channel<DefaultStreamChatGenerics> };
  };
  let events$: Subject<ClientEvent>;
  let connectionState$: Subject<'online' | 'offline'>;
  let init: (
    c?: Channel<DefaultStreamChatGenerics>[],
    sort?: ChannelSort<DefaultStreamChatGenerics>,
    options?: ChannelOptions & { keepAliveChannels$OnError?: boolean },
    mockChannelQuery?: Function,
    shouldSetActiveChannel?: boolean
  ) => Promise<Channel<DefaultStreamChatGenerics>[]>;
  let user: UserResponse;
  const filters = { type: 'messaging' };

  beforeEach(() => {
    user = mockCurrentUser();
    connectionState$ = new Subject<'online' | 'offline'>();
    mockChatClient = {
      queryChannels: jasmine
        .createSpy()
        .and.returnValue(generateMockChannels()),
      channel: jasmine.createSpy(),
      updateMessage: jasmine.createSpy(),
      deleteMessage: jasmine.createSpy(),
      userID: user.id,
      pinMessage: jasmine.createSpy(),
      unpinMessage: jasmine.createSpy(),
      activeChannels: {},
    };
    events$ = new Subject();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: ChatClientService,
          useValue: {
            chatClient: { ...mockChatClient, user },
            events$,
            connectionState$,
          },
        },
        NotificationService,
      ],
    });
    service = TestBed.inject(ChannelService);
    init = async (
      channels?: Channel<DefaultStreamChatGenerics>[],
      sort?: ChannelSort<DefaultStreamChatGenerics>,
      options?: ChannelOptions & { keepAliveChannels$OnError?: boolean },
      mockChannelQuery?: Function,
      shouldSetActiveChannel?: boolean
    ) => {
      if (mockChannelQuery) {
        mockChannelQuery();
      } else {
        mockChatClient.queryChannels.and.returnValue(
          channels || generateMockChannels()
        );
      }

      return service.init(filters, sort, options, shouldSetActiveChannel);
    };
  });

  it('should use provided sort params', async () => {
    const sort: ChannelSort = { last_message_at: -1 };
    await init(undefined, sort);

    expect(mockChatClient.queryChannels).toHaveBeenCalledWith(
      jasmine.any(Object),
      sort,
      jasmine.any(Object)
    );
  });

  it('should use provided options params', async () => {
    const options: ChannelOptions = { offset: 5 };
    await init(undefined, undefined, options);

    expect(mockChatClient.queryChannels).toHaveBeenCalledWith(
      jasmine.any(Object),
      jasmine.any(Object),
      jasmine.objectContaining(options)
    );
  });

  it('should use provided filter params', async () => {
    await init();

    expect(mockChatClient.queryChannels).toHaveBeenCalledWith(
      filters,
      jasmine.any(Object),
      jasmine.any(Object)
    );
  });

  it('should emit #channels$', async () => {
    await init();
    const spy = jasmine.createSpy();
    service.channels$.subscribe(spy);
    const mockChannels = generateMockChannels();

    const result = spy.calls.mostRecent().args[0] as Channel[];
    result.forEach((channel, index) => {
      expect(channel.cid).toEqual(mockChannels[index].cid);
    });
  });

  it('should return the result of the init', async () => {
    const notificationService = TestBed.inject(NotificationService);
    const notificationSpy = jasmine.createSpy();
    notificationService.notifications$.subscribe(notificationSpy);
    notificationSpy.calls.reset();
    const expectedResult = generateMockChannels();
    const result = await init(expectedResult);

    expect(result as any as MockChannel[]).toEqual(expectedResult);
    expect(notificationSpy).not.toHaveBeenCalled();
  });

  it('should return the result of the init - error', async () => {
    const notificationService = TestBed.inject(NotificationService);
    const notificationSpy = jasmine.createSpy();
    notificationService.notifications$.subscribe(notificationSpy);
    notificationSpy.calls.reset();
    const error = 'there was an error';

    await expectAsync(
      init(undefined, undefined, undefined, () =>
        mockChatClient.queryChannels.and.rejectWith(error)
      )
    ).toBeRejectedWith(error);

    expect(notificationSpy).toHaveBeenCalledWith(
      jasmine.arrayContaining([
        jasmine.objectContaining({
          type: 'error',
          text: 'streamChat.Error loading channels',
        }),
      ])
    );
  });

  it('should handle errors during channel load', fakeAsync(() => {
    const spy = jasmine.createSpy();
    service.channels$.subscribe(spy);
    const activeChannelSpy = jasmine.createSpy();
    service.activeChannel$.subscribe(activeChannelSpy);

    try {
      void init(undefined, undefined, { keepAliveChannels$OnError: true }, () =>
        mockChatClient.queryChannels.and.rejectWith('there was an error')
      );
      tick();
      // eslint-disable-next-line no-empty
    } catch (error) {}

    const channels = generateMockChannels();
    mockChatClient.queryChannels.and.resolveTo(channels);
    spy.calls.reset();
    activeChannelSpy.calls.reset();
    const notificationService = TestBed.inject(NotificationService);
    const notificationSpy = jasmine.createSpy();
    notificationService.notifications$.subscribe(notificationSpy);
    notificationSpy.calls.reset();
    events$.next({ eventType: 'connection.recovered' } as ClientEvent);

    tick();

    expect(spy).toHaveBeenCalledWith(channels);
    expect(activeChannelSpy).toHaveBeenCalledWith(channels[0]);
    expect(notificationSpy).toHaveBeenCalledWith([]);
  }));

  it('should emit channel query state correctly', async () => {
    const spy = jasmine.createSpy();
    service.channelQueryState$.subscribe(spy);

    await init();

    let calls = spy.calls.all();

    /* eslint-disable  @typescript-eslint/no-unsafe-member-access */
    expect(calls[1].args[0].state).toBe('in-progress');

    expect(calls[2].args[0].state).toBe('success');

    spy.calls.reset();

    await expectAsync(
      init(undefined, undefined, undefined, () =>
        mockChatClient.queryChannels.and.rejectWith('there was an error')
      )
    ).toBeRejected();

    calls = spy.calls.all();

    expect(calls[0].args[0]?.state).toBe('in-progress');

    expect(calls[1].args[0]).toEqual({
      state: 'error',
      error: 'there was an error',
    });

    /* eslint-enable  @typescript-eslint/no-unsafe-member-access */
  });

  it('should not set active channel if #shouldSetActiveChannel is false', async () => {
    const activeChannelSpy = jasmine.createSpy();
    service.activeChannel$.subscribe(activeChannelSpy);
    activeChannelSpy.calls.reset();
    await init(undefined, undefined, undefined, undefined, false);

    expect(activeChannelSpy).not.toHaveBeenCalled();
  });

  it('should reset', async () => {
    await init();
    const messagesSpy = jasmine.createSpy();
    service.activeChannelMessages$.subscribe(messagesSpy);
    const activeChannelSpy = jasmine.createSpy();
    service.activeChannel$.subscribe(activeChannelSpy);
    const channelsSpy = jasmine.createSpy();
    service.channels$.subscribe(channelsSpy);
    const messageToQuoteSpy = jasmine.createSpy();
    service.messageToQuote$.subscribe(messageToQuoteSpy);
    const latestMessagesSpy = jasmine.createSpy();
    service.latestMessageDateByUserByChannels$.subscribe(latestMessagesSpy);
    const jumpToMessageSpy = jasmine.createSpy();
    service.jumpToMessage$.subscribe(jumpToMessageSpy);
    const pinnedMessagesSpy = jasmine.createSpy();
    service.activeChannelPinnedMessages$.subscribe(pinnedMessagesSpy);
    const channelsQueryStateSpy = jasmine.createSpy();
    service.channelQueryState$.subscribe(channelsQueryStateSpy);
    messagesSpy.calls.reset();
    activeChannelSpy.calls.reset();
    channelsSpy.calls.reset();
    messageToQuoteSpy.calls.reset();
    latestMessagesSpy.calls.reset();
    jumpToMessageSpy.calls.reset();
    pinnedMessagesSpy.calls.reset();
    channelsQueryStateSpy.calls.reset();
    service.reset();

    expect(messagesSpy).toHaveBeenCalledWith([]);
    expect(channelsSpy).toHaveBeenCalledWith(undefined);
    expect(activeChannelSpy).toHaveBeenCalledWith(undefined);
    expect(messageToQuoteSpy).toHaveBeenCalledWith(undefined);
    expect(latestMessagesSpy).toHaveBeenCalledWith({});
    expect(pinnedMessagesSpy).toHaveBeenCalledWith([]);
    expect(channelsQueryStateSpy).toHaveBeenCalledWith(undefined);

    channelsSpy.calls.reset();
    events$.next({
      eventType: 'message.new',
      event: {
        channel: {
          id: 'channel',
        } as ChannelResponse<DefaultStreamChatGenerics>,
      } as Event<DefaultStreamChatGenerics>,
    });

    expect(channelsSpy).not.toHaveBeenCalled();
  });

  it('should deselect active channel', async () => {
    await init();
    let activeChannel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.pipe(take(1)).subscribe((c) => (activeChannel = c!));
    const messagesSpy = jasmine.createSpy();
    service.activeChannelMessages$.subscribe(messagesSpy);
    const activeChannelSpy = jasmine.createSpy();
    service.activeChannel$.subscribe(activeChannelSpy);
    const messageToQuoteSpy = jasmine.createSpy();
    service.messageToQuote$.subscribe(messageToQuoteSpy);
    const latestMessagesSpy = jasmine.createSpy();
    service.latestMessageDateByUserByChannels$.subscribe(latestMessagesSpy);
    const jumpToMessageSpy = jasmine.createSpy();
    service.jumpToMessage$.subscribe(jumpToMessageSpy);
    const pinnedMessagesSpy = jasmine.createSpy();
    service.activeChannelPinnedMessages$.subscribe(pinnedMessagesSpy);
    const typingUsersSpy = jasmine.createSpy();
    service.usersTypingInChannel$.subscribe(typingUsersSpy);
    const typingUsersInThreadSpy = jasmine.createSpy();
    service.usersTypingInThread$.subscribe(typingUsersInThreadSpy);
    messagesSpy.calls.reset();
    activeChannelSpy.calls.reset();
    messageToQuoteSpy.calls.reset();
    latestMessagesSpy.calls.reset();
    jumpToMessageSpy.calls.reset();
    pinnedMessagesSpy.calls.reset();
    typingUsersSpy.calls.reset();
    typingUsersInThreadSpy.calls.reset();
    service.deselectActiveChannel();

    expect(messagesSpy).toHaveBeenCalledWith([]);
    expect(activeChannelSpy).toHaveBeenCalledWith(undefined);
    expect(messageToQuoteSpy).toHaveBeenCalledWith(undefined);
    expect(latestMessagesSpy).toHaveBeenCalledWith({});
    expect(jumpToMessageSpy).toHaveBeenCalledWith({
      id: undefined,
      parentId: undefined,
    });

    expect(pinnedMessagesSpy).toHaveBeenCalledWith([]);
    expect(typingUsersSpy).toHaveBeenCalledWith([]);
    expect(typingUsersInThreadSpy).toHaveBeenCalledWith([]);

    messagesSpy.calls.reset();
    (activeChannel as MockChannel).handleEvent('message.new', mockMessage());

    expect(messagesSpy).not.toHaveBeenCalled();
  });

  it('should tell if user #hasMoreChannels$', async () => {
    await init();
    const spy = jasmine.createSpy();
    service.hasMoreChannels$.subscribe(spy);

    expect(spy).toHaveBeenCalledWith(true);

    mockChatClient.queryChannels.and.callFake(() => {
      const channels = generateMockChannels();
      channels.pop();
      return channels;
    });
    spy.calls.reset();
    await service.loadMoreChannels();

    expect(spy).toHaveBeenCalledWith(false);
  });

  it('should load more channels', async () => {
    await init();
    mockChatClient.queryChannels.calls.reset();
    await service.loadMoreChannels();

    expect(mockChatClient.queryChannels).toHaveBeenCalledWith(
      jasmine.any(Object),
      jasmine.any(Object),
      jasmine.any(Object)
    );
  });

  it('should set active channel', async () => {
    await init();
    const spy = jasmine.createSpy();
    service.activeChannel$.subscribe(spy);
    const pinnedMessagesSpy = jasmine.createSpy();
    service.activeChannelPinnedMessages$.subscribe(pinnedMessagesSpy);
    pinnedMessagesSpy.calls.reset();
    const mockChannels = generateMockChannels();

    let result = spy.calls.mostRecent().args[0] as Channel;

    expect(result.cid).toBe(mockChannels[0].cid);

    const messagesSpy = jasmine.createSpy();
    service.activeChannelMessages$.subscribe(messagesSpy);
    messagesSpy.calls.reset();
    const messageToQuoteSpy = jasmine.createSpy();
    service.messageToQuote$.subscribe(messageToQuoteSpy);
    messageToQuoteSpy.calls.reset();
    const typingUsersSpy = jasmine.createSpy();
    service.usersTypingInChannel$.subscribe(typingUsersSpy);
    typingUsersSpy.calls.reset();
    const typingUsersInThreadSpy = jasmine.createSpy();
    service.usersTypingInThread$.subscribe(typingUsersInThreadSpy);
    typingUsersInThreadSpy.calls.reset();
    const newActiveChannel = mockChannels[1];
    spyOn(newActiveChannel, 'markRead');
    const pinnedMessages = generateMockMessages();
    newActiveChannel.state.pinnedMessages = pinnedMessages;
    service.setAsActiveChannel(newActiveChannel);
    result = spy.calls.mostRecent().args[0] as Channel;

    expect(result.cid).toBe(newActiveChannel.cid);
    expect(messagesSpy).toHaveBeenCalledWith(jasmine.any(Object));
    expect(newActiveChannel.markRead).toHaveBeenCalledWith();
    expect(messageToQuoteSpy).toHaveBeenCalledWith(undefined);
    expect(pinnedMessagesSpy).toHaveBeenCalledWith(pinnedMessages);
    expect(typingUsersSpy).toHaveBeenCalledWith([]);
    expect(typingUsersInThreadSpy).toHaveBeenCalledWith([]);
  });

  it('should emit #activeChannelMessages$', async () => {
    await init();
    const spy = jasmine.createSpy();
    service.activeChannelMessages$.subscribe(spy);
    const messages = generateMockChannels()[0].state.messages;

    const result = spy.calls.mostRecent().args[0] as StreamMessage[];
    result.forEach((m, i) => {
      expect(m.id).toEqual(messages[i].id);
    });
  });

  it('should add readBy field to messages', async () => {
    await init();
    /* eslint-disable jasmine/new-line-before-expect */
    service.activeChannelMessages$.subscribe((messages) => {
      messages.forEach((m) => expect(m.readBy).not.toBeUndefined());
    });
    /* eslint-enable jasmine/new-line-before-expect */
  });

  it('should load more older messages', async () => {
    await init();
    let activeChannel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.subscribe(
      (c) => (activeChannel = c as Channel<DefaultStreamChatGenerics>)
    );
    spyOn(activeChannel, 'query').and.callThrough();
    await service.loadMoreMessages();

    expect(activeChannel.query).toHaveBeenCalledWith(jasmine.any(Object));

    const arg = (activeChannel.query as jasmine.Spy).calls.mostRecent()
      .args[0] as { messages: { id_lt: string } };
    const oldestMessage = activeChannel.state.messages[0];

    expect(arg.messages.id_lt).toEqual(oldestMessage.id);
  });

  it('should load more newer messages', async () => {
    await init();
    let activeChannel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.subscribe(
      (c) => (activeChannel = c as Channel<DefaultStreamChatGenerics>)
    );
    activeChannel.state.latestMessages = [];
    spyOn(activeChannel, 'query').and.callThrough();
    await service.loadMoreMessages('newer');

    expect(activeChannel.query).toHaveBeenCalledWith(jasmine.any(Object));

    const arg = (activeChannel.query as jasmine.Spy).calls.mostRecent()
      .args[0] as { messages: { id_gt: string } };
    const lastMessage =
      activeChannel.state.messages[activeChannel.state.messages.length - 1];

    expect(arg.messages.id_gt).toEqual(lastMessage.id);
  });

  it(`shouldn't load more newer messages if already at the latest messages`, async () => {
    await init();
    let activeChannel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.subscribe(
      (c) => (activeChannel = c as Channel<DefaultStreamChatGenerics>)
    );
    spyOn(activeChannel, 'query').and.callThrough();
    await service.loadMoreMessages('newer');

    expect(activeChannel.query).not.toHaveBeenCalled();

    await service.loadMoreMessages('older');

    expect(activeChannel.query).toHaveBeenCalledWith(jasmine.any(Object));
  });

  it('should add reaction', async () => {
    await init();
    let activeChannel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.subscribe((c) => (activeChannel = c!));
    spyOn(activeChannel, 'sendReaction');
    const messageId = 'id';
    const reactionType = 'wow';
    await service.addReaction(messageId, reactionType);

    expect(activeChannel.sendReaction).toHaveBeenCalledWith(messageId, {
      type: reactionType,
    });
  });

  it('should remove reaction', async () => {
    await init();
    let activeChannel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.subscribe((c) => (activeChannel = c!));
    spyOn(activeChannel, 'deleteReaction');
    const messageId = 'id';
    const reactionType = 'wow';
    await service.removeReaction(messageId, reactionType);

    expect(activeChannel.deleteReaction).toHaveBeenCalledWith(
      messageId,
      reactionType
    );
  });

  it('should watch for new message events', async () => {
    await init();
    const spy = jasmine.createSpy();
    service.activeChannelMessages$.subscribe(spy);
    const prevCount = (spy.calls.mostRecent().args[0] as Channel[]).length;
    spy.calls.reset();
    let activeChannel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.subscribe((c) => (activeChannel = c!));
    const newMessage = mockMessage();
    activeChannel.state.messages.push(newMessage);
    spyOn(activeChannel, 'markRead');
    (activeChannel as MockChannel).handleEvent('message.new', newMessage);

    const newCount = (spy.calls.mostRecent().args[0] as StreamMessage[]).length;

    expect(newCount).toBe(prevCount + 1);
    expect(activeChannel.markRead).toHaveBeenCalledWith();
  });

  it('should pause read events', async () => {
    await init();
    service.shouldMarkActiveChannelAsRead = false;
    let activeChannel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.subscribe((c) => (activeChannel = c!));
    const newMessage = mockMessage();
    activeChannel.state.messages.push(newMessage);
    spyOn(activeChannel, 'markRead');
    (activeChannel as MockChannel).handleEvent('message.new', newMessage);

    expect(activeChannel.markRead).not.toHaveBeenCalledWith();

    service.setAsActiveChannel(activeChannel);

    expect(activeChannel.markRead).not.toHaveBeenCalledWith();

    service.shouldMarkActiveChannelAsRead = true;

    expect(activeChannel.markRead).toHaveBeenCalledWith();
  });

  it(`shouldn't make "markRead" call, if user dosen't have 'read-events' capability`, async () => {
    await init();
    let activeChannel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.subscribe((c) => (activeChannel = c!));
    const capabilites = activeChannel.data?.own_capabilities as string[];
    capabilites.splice(capabilites.indexOf('read-events'), 1);
    const newMessage = mockMessage();
    activeChannel.state.messages.push(newMessage);
    spyOn(activeChannel, 'markRead');
    (activeChannel as MockChannel).handleEvent('message.new', newMessage);

    expect(activeChannel.markRead).not.toHaveBeenCalledWith();

    service.setAsActiveChannel(activeChannel);

    expect(activeChannel.markRead).not.toHaveBeenCalledWith();
  });

  it('should watch for message update events', async () => {
    await init();
    const spy = jasmine.createSpy();
    service.activeChannelMessages$.subscribe(spy);
    spy.calls.reset();
    const pinnedMessagesSpy = jasmine.createSpy();
    service.activeChannelPinnedMessages$.subscribe(pinnedMessagesSpy);
    pinnedMessagesSpy.calls.reset();
    let activeChannel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.subscribe((c) => (activeChannel = c!));
    const pinnedMessages = generateMockMessages();
    activeChannel.state.pinnedMessages = pinnedMessages;
    const message =
      activeChannel.state.messages[activeChannel.state.messages.length - 1];
    message.text = 'updated';
    (activeChannel as MockChannel).handleEvent('message.updated', { message });

    const messages = spy.calls.mostRecent().args[0] as StreamMessage[];
    const updatedMessage = messages[messages.length - 1];

    expect(updatedMessage.text).toBe('updated');

    expect(pinnedMessagesSpy).toHaveBeenCalledWith(pinnedMessages);
  });

  it('should watch for message deleted events', async () => {
    await init();
    const spy = jasmine.createSpy();
    service.activeChannelMessages$.subscribe(spy);
    spy.calls.reset();
    let activeChannel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.subscribe((c) => (activeChannel = c!));
    const message =
      activeChannel.state.messages[activeChannel.state.messages.length - 1];
    message.deleted_at = new Date().toISOString();
    (activeChannel as MockChannel).handleEvent('message.deleted', { message });

    expect(spy).toHaveBeenCalledWith(jasmine.arrayContaining([message]));
  });

  it('should move channel to the top of the list', async () => {
    await init();
    let channel!: Channel<DefaultStreamChatGenerics>;
    service.channels$
      .pipe(first())
      .subscribe((channels) => (channel = channels![1]));
    const spy = jasmine.createSpy();
    service.channels$.subscribe(spy);
    const event = {
      message: mockMessage(),
      type: 'message.new',
    } as any as Event<DefaultStreamChatGenerics>;
    (channel as MockChannel).handleEvent('message.new', event);

    const firtChannel = (spy.calls.mostRecent().args[0] as Channel[])[0];

    expect(firtChannel).toBe(channel);
  });

  it('should call custom #customNewMessageHandler, if handler is provided', async () => {
    await init();
    let channel!: Channel<DefaultStreamChatGenerics>;
    service.channels$
      .pipe(first())
      .subscribe((channels) => (channel = channels![1]));
    const spy = jasmine.createSpy();
    service.customNewMessageHandler = spy;
    const event = {
      message: mockMessage(),
      type: 'message.new',
    } as any as Event<DefaultStreamChatGenerics>;
    (channel as MockChannel).handleEvent('message.new', event);

    expect(spy).toHaveBeenCalledWith(
      event,
      channel,
      jasmine.any(Function),
      jasmine.any(Function),
      jasmine.any(Function),
      jasmine.any(Function)
    );
  });

  it('should handle if channel visibility changes', async () => {
    await init();
    let channel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.pipe(first()).subscribe((c) => (channel = c!));
    const spy = jasmine.createSpy();
    service.channels$.subscribe(spy);
    mockChatClient.activeChannels[channel.cid] = channel;
    spyOn(channel, 'stopWatching');
    (channel as MockChannel).handleEvent('channel.hidden', {
      type: 'channel.hidden',
      channel,
    });

    let channels = spy.calls.mostRecent().args[0] as Channel[];

    expect(channels.find((c) => c.cid === channel.cid)).toBeUndefined();
    expect(channel.stopWatching).toHaveBeenCalledWith();

    (channel as MockChannel).handleEvent('channel.hidden', {
      type: 'channel.visible',
      channel,
    });

    channels = spy.calls.mostRecent().args[0] as Channel[];

    expect(channels.find((c) => c.cid === channel.cid)).not.toBeUndefined();
  });

  it('should handle if channel visibility changes, if custom event handlers are provided', async () => {
    await init();
    let channel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.pipe(first()).subscribe((c) => (channel = c!));
    const visibleSpy = jasmine.createSpy();
    const hiddenSpy = jasmine.createSpy();
    service.customChannelVisibleHandler = visibleSpy;
    service.customChannelHiddenHandler = hiddenSpy;
    const hiddenEvent = {
      type: 'channel.hidden',
      channel,
    } as any as Event<DefaultStreamChatGenerics>;
    (channel as MockChannel).handleEvent('channel.hidden', hiddenEvent);

    expect(hiddenSpy).toHaveBeenCalledWith(
      hiddenEvent,
      channel,
      jasmine.any(Function),
      jasmine.any(Function),
      jasmine.any(Function),
      jasmine.any(Function)
    );

    const visibleEvent = {
      type: 'channel.visible',
      channel,
    } as any as Event<DefaultStreamChatGenerics>;
    (channel as MockChannel).handleEvent('channel.hidden', visibleEvent);

    expect(visibleSpy).toHaveBeenCalledWith(
      visibleEvent,
      channel,
      jasmine.any(Function),
      jasmine.any(Function),
      jasmine.any(Function),
      jasmine.any(Function)
    );
  });

  it('should remove channel from list, if deleted', async () => {
    await init();
    let channel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.pipe(first()).subscribe((c) => (channel = c!));
    const spy = jasmine.createSpy();
    service.channels$.subscribe(spy);
    mockChatClient.activeChannels[channel.cid] = channel;
    spyOn(channel, 'stopWatching');
    (channel as MockChannel).handleEvent('channel.deleted', {
      type: 'channel.deleted',
      channel,
    });

    const channels = spy.calls.mostRecent().args[0] as Channel[];

    expect(channels.find((c) => c.cid === channel.cid)).toBeUndefined();
    expect(channel.stopWatching).toHaveBeenCalledWith();
  });

  it('should call #customChannelDeletedHandler, if channel is deleted and handler is provided', async () => {
    await init();
    let channel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.pipe(first()).subscribe((c) => (channel = c!));
    const spy = jasmine.createSpy();
    service.customChannelDeletedHandler = spy;
    const event = {
      type: 'channel.deleted',
      channel,
    } as any as Event<DefaultStreamChatGenerics>;
    (channel as MockChannel).handleEvent('channel.deleted', event);

    expect(spy).toHaveBeenCalledWith(
      event,
      channel,
      jasmine.any(Function),
      jasmine.any(Function),
      jasmine.any(Function),
      jasmine.any(Function)
    );
  });

  it('should update channel in list, if updated', async () => {
    await init();
    let channel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.pipe(first()).subscribe((c) => (channel = c!));
    const spy = jasmine.createSpy();
    service.channels$.subscribe(spy);
    (channel as MockChannel).handleEvent('channel.updated', {
      type: 'channel.updated',
      channel: {
        cid: channel.cid,
        name: 'New name',
      },
    });

    const channels = spy.calls.mostRecent().args[0] as Channel[];

    const updatedChannel = channels.find((c) => c.cid === channel.cid);

    expect(updatedChannel!.data!.name).toBe('New name');
    expect(updatedChannel!.data!.own_capabilities).toBeDefined();
    expect(updatedChannel!.data!.hidden).toBeDefined();
  });

  it('should call #customChannelUpdatedHandler, if updated and handler is provided', async () => {
    await init();
    let channel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.pipe(first()).subscribe((c) => (channel = c!));
    const spy = jasmine.createSpy();
    service.customChannelUpdatedHandler = spy;
    const event = {
      type: 'channel.updated',
      channel: {
        cid: channel.cid,
        name: 'New name',
      },
    } as Event<DefaultStreamChatGenerics>;
    (channel as MockChannel).handleEvent('channel.updated', event);

    expect(spy).toHaveBeenCalledWith(
      event,
      channel,
      jasmine.any(Function),
      jasmine.any(Function),
      jasmine.any(Function),
      jasmine.any(Function)
    );
  });

  it('should handle if channel is truncated', async () => {
    await init();
    let channel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.pipe(first()).subscribe((c) => (channel = c!));
    const channelsSpy = jasmine.createSpy();
    service.channels$.subscribe(channelsSpy);
    const messagesSpy = jasmine.createSpy();
    service.activeChannelMessages$.subscribe(messagesSpy);
    (channel as MockChannel).handleEvent('channel.truncated', {
      type: 'channel.truncated',
      channel: {
        cid: channel.cid,
        name: 'New name',
      },
    });

    const channels = channelsSpy.calls.mostRecent().args[0] as Channel[];

    expect(
      channels.find((c) => c.cid === channel.cid)!.state.messages.length
    ).toBe(0);

    expect(messagesSpy).toHaveBeenCalledWith([]);
  });

  it('should call #customChannelTruncatedHandler, if channel is truncated and custom handler is provided', async () => {
    await init();
    let channel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.pipe(first()).subscribe((c) => (channel = c!));
    const spy = jasmine.createSpy();
    service.customChannelTruncatedHandler = spy;
    const event = {
      type: 'channel.truncated',
      channel: {
        cid: channel.cid,
        name: 'New name',
      },
    } as Event<DefaultStreamChatGenerics>;
    (channel as MockChannel).handleEvent('channel.truncated', event);

    expect(spy).toHaveBeenCalledWith(
      event,
      channel,
      jasmine.any(Function),
      jasmine.any(Function),
      jasmine.any(Function),
      jasmine.any(Function)
    );
  });

  it('should watch for reaction events', async () => {
    await init();
    const spy = jasmine.createSpy();
    service.activeChannelMessages$.subscribe(spy);
    const message = (spy.calls.mostRecent().args[0] as StreamMessage[])[0];
    spy.calls.reset();
    let activeChannel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.subscribe((c) => (activeChannel = c!));
    (activeChannel as MockChannel).handleEvent('reaction.new', { message });

    expect(spy).toHaveBeenCalledWith(jasmine.any(Object));

    spy.calls.reset();
    (activeChannel as MockChannel).handleEvent('reaction.updated', { message });

    expect(spy).toHaveBeenCalledWith(jasmine.any(Object));

    spy.calls.reset();
    (activeChannel as MockChannel).handleEvent('reaction.deleted', { message });

    expect(spy).toHaveBeenCalledWith(jasmine.any(Object));
  });

  it('should watch for channel events', async () => {
    const channel = generateMockChannels(1)[0];
    spyOn(channel, 'on').and.callThrough();
    await init([channel]);

    expect(channel.on).toHaveBeenCalledWith(jasmine.any(Function));
  });

  it('should add the new channel to the top of the list, and start watching it, if user is added to a channel', fakeAsync(async () => {
    await init();
    const newChannel = generateMockChannels()[0];
    newChannel.cid = 'newchannel';
    newChannel.id = 'newchannel';
    newChannel.type = 'messaging';
    mockChatClient.channel.and.returnValue(newChannel);
    spyOn(newChannel, 'watch').and.callThrough();
    spyOn(newChannel, 'on').and.callThrough();
    const spy = jasmine.createSpy();
    service.channels$.subscribe(spy);
    events$.next({
      eventType: 'notification.added_to_channel',
      event: { channel: newChannel } as any as Event<DefaultStreamChatGenerics>,
    });
    tick();

    const channels = spy.calls.mostRecent().args[0] as Channel[];
    const firstChannel = channels[0];

    expect(firstChannel.cid).toBe(newChannel.cid);
    expect(newChannel.watch).toHaveBeenCalledWith();
    expect(newChannel.on).toHaveBeenCalledWith(jasmine.any(Function));
  }));

  it('should add the new channel to the top of the list, and start watching it, if a new message is received from the channel', fakeAsync(async () => {
    await init();
    const channel = generateMockChannels()[0];
    channel.cid = 'channel';
    channel.id = 'channel';
    channel.type = 'messaging';
    mockChatClient.channel.and.returnValue(channel);
    spyOn(channel, 'watch').and.callThrough();
    spyOn(channel, 'on').and.callThrough();
    const spy = jasmine.createSpy();
    service.channels$.subscribe(spy);
    events$.next({
      eventType: 'notification.message_new',
      event: { channel: channel } as any as Event<DefaultStreamChatGenerics>,
    });
    tick();

    const channels = spy.calls.mostRecent().args[0] as Channel[];
    const firstChannel = channels[0];

    expect(firstChannel.cid).toBe(channel.cid);
    expect(channel.watch).toHaveBeenCalledWith();
    expect(channel.on).toHaveBeenCalledWith(jasmine.any(Function));
  }));

  it(`shouldn't add channels twice if two notification events were received for the same channel`, fakeAsync(async () => {
    await init();
    const channel = generateMockChannels()[0];
    channel.cid = 'channel';
    channel.id = 'channel';
    channel.type = 'messaging';
    mockChatClient.channel.and.returnValue(channel);
    spyOn(channel, 'watch').and.callThrough();
    spyOn(channel, 'on').and.callThrough();
    const spy = jasmine.createSpy();
    service.channels$.subscribe(spy);
    events$.next({
      eventType: 'notification.added_to_channel',
      event: { channel: channel } as any as Event<DefaultStreamChatGenerics>,
    });
    events$.next({
      eventType: 'notification.message_new',
      event: { channel: channel } as any as Event<DefaultStreamChatGenerics>,
    });
    tick();

    const channels = spy.calls.mostRecent().args[0] as Channel[];

    expect(channels.filter((c) => c.cid === channel.cid).length).toBe(1);
    expect(channel.on).toHaveBeenCalledOnceWith(jasmine.any(Function));
  }));

  it('should remove channel form the list if user is removed from channel', async () => {
    await init();
    let channel!: Channel<DefaultStreamChatGenerics>;
    service.channels$
      .pipe(first())
      .subscribe((channels) => (channel = channels![1]));
    const spy = jasmine.createSpy();
    service.channels$.subscribe(spy);
    mockChatClient.activeChannels[channel.cid] = channel;
    spyOn(channel, 'stopWatching');
    spyOn(service, 'setAsActiveChannel');
    events$.next({
      eventType: 'notification.removed_from_channel',
      event: { channel: channel } as any as Event<DefaultStreamChatGenerics>,
    });

    const channels = spy.calls.mostRecent().args[0] as Channel[];

    expect(channels.find((c) => c.cid === channel.cid)).toBeUndefined();
    expect(service.setAsActiveChannel).not.toHaveBeenCalled();
    expect(channel.stopWatching).toHaveBeenCalledWith();
  });

  it('should remove channel form the list if user is removed from channel, and emit new active channel', async () => {
    await init();
    let channel!: Channel<DefaultStreamChatGenerics>;
    let newActiveChannel!: Channel<DefaultStreamChatGenerics>;
    service.channels$.pipe(first()).subscribe((channels) => {
      channel = channels![0];
      newActiveChannel = channels![1];
    });
    const spy = jasmine.createSpy();
    service.channels$.subscribe(spy);
    spyOn(service, 'setAsActiveChannel');
    events$.next({
      eventType: 'notification.removed_from_channel',
      event: { channel: channel } as any as Event<DefaultStreamChatGenerics>,
    });

    const channels = spy.calls.mostRecent().args[0] as Channel[];

    expect(channels.find((c) => c.cid === channel.cid)).toBeUndefined();
    expect(service.setAsActiveChannel).toHaveBeenCalledWith(newActiveChannel);
  });

  it('should call custom new message notification handler, if custom handler is provided', async () => {
    await init();
    const spy = jasmine.createSpy();
    service.customNewMessageNotificationHandler = spy;
    let channel!: Channel<DefaultStreamChatGenerics>;
    service.channels$
      .pipe(first())
      .subscribe((channels) => (channel = channels![1]));
    const event = {
      channel: channel,
    } as any as Event<DefaultStreamChatGenerics>;
    const channelsSpy = jasmine.createSpy();
    service.channels$.subscribe(channelsSpy);
    channelsSpy.calls.reset();
    events$.next({
      eventType: 'notification.message_new',
      event: event,
    });

    expect(spy).toHaveBeenCalledWith(
      { eventType: 'notification.message_new', event },
      jasmine.any(Function)
    );

    expect(channelsSpy).not.toHaveBeenCalled();
  });

  it('should call custom added to channel notification handler, if custom handler is provided', async () => {
    await init();
    const spy = jasmine
      .createSpy()
      .and.callFake((_: ClientEvent, setter: (channels: Channel[]) => []) =>
        setter([])
      );
    service.customAddedToChannelNotificationHandler = spy;
    let channel!: Channel<DefaultStreamChatGenerics>;
    service.channels$
      .pipe(first())
      .subscribe((channels) => (channel = channels![1]));
    const event = {
      channel: channel,
    } as any as Event<DefaultStreamChatGenerics>;
    const channelsSpy = jasmine.createSpy();
    service.channels$.subscribe(channelsSpy);
    channelsSpy.calls.reset();
    events$.next({
      eventType: 'notification.added_to_channel',
      event: event,
    });

    expect(spy).toHaveBeenCalledWith(
      { eventType: 'notification.added_to_channel', event },
      jasmine.any(Function)
    );

    expect(channelsSpy).toHaveBeenCalledWith([]);
  });

  it('should call custom removed from channel notification handler, if custom handler is provided', async () => {
    await init();
    const spy = jasmine.createSpy();
    service.customRemovedFromChannelNotificationHandler = spy;
    let channel!: Channel<DefaultStreamChatGenerics>;
    service.channels$
      .pipe(first())
      .subscribe((channels) => (channel = channels![1]));
    const event = {
      channel: channel,
    } as any as Event<DefaultStreamChatGenerics>;
    const channelsSpy = jasmine.createSpy();
    service.channels$.subscribe(channelsSpy);
    channelsSpy.calls.reset();
    events$.next({
      eventType: 'notification.removed_from_channel',
      event: event,
    });

    expect(spy).toHaveBeenCalledWith(
      { eventType: 'notification.removed_from_channel', event },
      jasmine.any(Function)
    );

    expect(channelsSpy).not.toHaveBeenCalled();
  });

  it('should send message', async () => {
    await init();
    let channel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.pipe(first()).subscribe((c) => (channel = c!));
    spyOn(channel, 'sendMessage').and.callThrough();
    spyOn(channel.state, 'addMessageSorted').and.callThrough();
    const text = 'Hi';
    const attachments = [{ fallback: 'image.png', url: 'http://url/to/image' }];
    const mentionedUsers = [{ id: 'sara', name: 'Sara' }];
    const quotedMessageId = 'quotedMessage';
    const customData = {
      isVote: true,
      options: ['A', 'B', 'C'],
    };
    let prevMessageCount!: number;
    service.activeChannelMessages$
      .pipe(first())
      .subscribe((m) => (prevMessageCount = m.length));
    await service.sendMessage(
      text,
      attachments,
      mentionedUsers,
      undefined,
      quotedMessageId,
      customData
    );
    let latestMessage!: StreamMessage;
    let messageCount!: number;
    service.activeChannelMessages$.subscribe((m) => {
      latestMessage = m[m.length - 1];
      messageCount = m.length;
    });

    expect(channel.sendMessage).toHaveBeenCalledWith({
      text,
      attachments,
      mentioned_users: ['sara'],
      id: jasmine.any(String),
      parent_id: undefined,
      quoted_message_id: quotedMessageId,
      isVote: true,
      options: ['A', 'B', 'C'],
    });

    expect(channel.state.addMessageSorted).toHaveBeenCalledWith(
      jasmine.objectContaining({ text, user, attachments }),
      true
    );

    expect(latestMessage.text).toBe(text);
    expect(messageCount).toEqual(prevMessageCount + 1);
  });

  it('should send action', async () => {
    await init();
    let channel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.pipe(first()).subscribe((c) => (channel = c!));
    const giphy = {
      thumb_url:
        'https://media4.giphy.com/media/Q9GYuPJTT8RomJTRot/giphy.gif?cid=c4b036752at3vu1m2vwt7nvnfumyer5620wbdhosrpmds52e&rid=giphy.gif&ct=g',
      title: 'dogs',
      title_link: 'https://giphy.com/gifs/Q9GYuPJTT8RomJTRot',
      type: 'giphy',
    };
    spyOn(channel, 'sendAction').and.resolveTo({
      message: {
        id: 'message-1',
        attachments: [giphy],
      },
    } as any as SendMessageAPIResponse<DefaultStreamChatGenerics>);
    let latestMessage!: StreamMessage;
    service.activeChannelMessages$.subscribe(
      (m) => (latestMessage = m[m.length - 1])
    );
    await service.sendAction('message-1', { image_action: 'send' });

    expect(latestMessage.attachments![0]).toBe(giphy);
  });

  it('should remove message after action, if no message is returned', async () => {
    await init();
    let channel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.pipe(first()).subscribe((c) => (channel = c!));
    spyOn(channel, 'sendAction').and.resolveTo(
      {} as any as SendMessageAPIResponse<DefaultStreamChatGenerics>
    );
    spyOn(channel.state, 'removeMessage');
    await service.sendAction('1', { image_action: 'send' });

    expect(channel.state.removeMessage).toHaveBeenCalledWith({
      id: '1',
      parent_id: undefined,
    });
  });

  it('should update message', () => {
    const message = mockMessage();
    void service.updateMessage(message);

    expect(mockChatClient.updateMessage).toHaveBeenCalledWith(message);
  });

  it('should remove translation object before updating message', () => {
    const message = mockMessage();
    void service.updateMessage({
      ...message,
      i18n: { en_text: 'Translation', language: 'en' },
    });

    expect(mockChatClient.updateMessage).toHaveBeenCalledWith(message);
  });

  it('should delete message', () => {
    const message = mockMessage();
    void service.deleteMessage(message);

    expect(mockChatClient.deleteMessage).toHaveBeenCalledWith(message.id);
  });

  it('should resend message', async () => {
    await init();
    let latestMessage!: StreamMessage;
    service.activeChannelMessages$.subscribe((m) => {
      latestMessage = m[m.length - 1];
    });
    latestMessage.status = 'failed';
    let channel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.pipe(first()).subscribe((c) => (channel = c!));
    spyOn(channel, 'sendMessage').and.callThrough();
    spyOn(channel.state, 'addMessageSorted').and.callThrough();
    await service.resendMessage(latestMessage);

    expect(channel.sendMessage).toHaveBeenCalledWith(
      jasmine.objectContaining({
        id: latestMessage.id,
      })
    );

    expect(channel.state.addMessageSorted).toHaveBeenCalledWith(
      jasmine.objectContaining({
        status: 'sending',
        errorStatusCode: undefined,
      }),
      true
    );

    expect(channel.state.addMessageSorted).toHaveBeenCalledWith(
      jasmine.objectContaining({
        status: 'received',
      }),
      true
    );

    expect(latestMessage.status).toBe('received');
  });

  it('should set message state while sending', async () => {
    await init();
    let channel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.pipe(first()).subscribe((c) => (channel = c!));
    spyOn(channel, 'sendMessage');
    const text = 'Hi';
    let latestMessage!: StreamMessage;
    service.activeChannelMessages$.subscribe(
      (m) => (latestMessage = m[m.length - 1])
    );
    void service.sendMessage(text);

    expect(latestMessage.status).toBe('sending');
  });

  it('should set message state after message is sent', async () => {
    await init();
    let channel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.pipe(first()).subscribe((c) => (channel = c!));
    spyOn(channel, 'sendMessage');
    const text = 'Hi';
    let latestMessage!: StreamMessage;
    service.activeChannelMessages$.subscribe(
      (m) => (latestMessage = m[m.length - 1])
    );
    await service.sendMessage(text);
    channel.state.messages.push({
      id: latestMessage.id,
    } as any as StreamMessage);
    (channel as MockChannel).handleEvent('message.new', {
      id: latestMessage.id,
    });

    expect(latestMessage.status).toBe('received');
  });

  // this could happen when a message was added to the local state while offline
  it('should handle message order change', async () => {
    await init();
    let channel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.pipe(first()).subscribe((c) => (channel = c!));
    const localMessage = channel.state.messages.splice(
      channel.state.messages.length - 2,
      1
    )[0];
    channel.state.messages.push(localMessage);
    (channel as MockChannel).handleEvent('message.new', localMessage);
    let latestMessage!: StreamMessage;
    service.activeChannelMessages$.subscribe(
      (m) => (latestMessage = m[m.length - 1])
    );

    expect(latestMessage.id).toBe(localMessage.id);
  });

  it('should set message state, if an error occured', async () => {
    await init();
    let channel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.pipe(first()).subscribe((c) => (channel = c!));
    spyOn(channel, 'sendMessage').and.callFake(() =>
      Promise.reject({ status: 500 })
    );
    const text = 'Hi';
    let latestMessage!: StreamMessage;
    service.activeChannelMessages$.subscribe(
      (m) => (latestMessage = m[m.length - 1])
    );
    await service.sendMessage(text);

    expect(latestMessage.status).toBe('failed');
    expect(latestMessage.errorStatusCode).toBe(500);
  });

  it('should add sent message to message list', async () => {
    await init();
    let channel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.pipe(first()).subscribe((c) => (channel = c!));
    spyOn(channel, 'sendMessage').and.callFake(() =>
      Promise.resolve({
        message: { id: 'new-message' },
      } as SendMessageAPIResponse<DefaultStreamChatGenerics>)
    );
    let latestMessage!: StreamMessage;
    service.activeChannelMessages$.subscribe(
      (m) => (latestMessage = m[m.length - 1])
    );
    await service.sendMessage('Hi');

    expect(latestMessage.id).toBe('new-message');
  });

  it(`shouldn't duplicate new message`, async () => {
    await init();
    let channel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.pipe(first()).subscribe((c) => (channel = c!));
    await service.sendMessage('Hi');
    let newMessageId!: string;
    service.activeChannelMessages$.pipe(first()).subscribe((m) => {
      newMessageId = m[m.length - 1].id;
    });
    (channel as MockChannel).handleEvent('message.new', { id: newMessageId });
    let messages!: StreamMessage[];
    service.activeChannelMessages$.pipe(first()).subscribe((m) => {
      messages = m;
    });

    expect(messages.filter((m) => m.id === newMessageId).length).toEqual(1);
  });

  it('should upload attachments', async () => {
    await init();
    let channel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.pipe(first()).subscribe((c) => (channel = c!));
    spyOn(channel, 'sendImage').and.callFake((file: File) => {
      switch (file.name) {
        case 'file_error.jpg':
          return Promise.reject(new Error());
        default:
          return Promise.resolve({
            file: 'http://url/to/image',
            duration: '200ms',
          });
      }
    });
    spyOn(channel, 'sendFile').and.callFake(
      (file: File, _: string, type: string) => {
        switch (file.name) {
          case 'file_error.pdf':
            return Promise.reject(new Error());
          default:
            return Promise.resolve({
              file: 'http://url/to/file',
              duration: '200ms',
              thumb_url:
                type && type.startsWith('video')
                  ? 'http://url/to/poster'
                  : undefined,
            });
        }
      }
    );
    const file1 = { name: 'food.png' } as File;
    const file2 = { name: 'file_error.jpg' } as File;
    const file3 = { name: 'menu.pdf' } as File;
    const file4 = { name: 'file_error.pdf' } as File;
    const file5 = { name: 'video.mp4', type: 'video/mp4' } as File;
    const attachments = [
      { file: file1, type: 'image', state: 'uploading' },
      { file: file2, type: 'image', state: 'uploading' },
      { file: file3, type: 'file', state: 'uploading' },
      { file: file4, type: 'file', state: 'uploading' },
      { file: file5, type: 'video', state: 'uploading' },
    ] as AttachmentUpload[];
    const result = await service.uploadAttachments(attachments);
    const expectedResult: AttachmentUpload[] = [
      {
        file: file1,
        state: 'success',
        url: 'http://url/to/image',
        type: 'image',
        thumb_url: undefined,
      },
      { file: file2, state: 'error', type: 'image' },
      {
        file: file3,
        state: 'success',
        url: 'http://url/to/file',
        type: 'file',
        thumb_url: undefined,
      },
      { file: file4, state: 'error', type: 'file' },
      {
        file: file5,
        state: 'success',
        type: 'video',
        url: 'http://url/to/file',
        thumb_url: 'http://url/to/poster',
      },
    ];

    expectedResult.forEach((r, i) => {
      expect(r).toEqual(result[i]);
    });
  });

  it('should delete image attachment', async () => {
    await init();
    let channel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.pipe(first()).subscribe((c) => (channel = c!));
    spyOn(channel, 'deleteImage');
    const url = 'http://url/to/image';
    await service.deleteAttachment({
      url,
      type: 'image',
      state: 'success',
      file: {} as any as File,
    });

    expect(channel.deleteImage).toHaveBeenCalledWith(url);
  });

  it('should delete file attachment', async () => {
    await init();
    let channel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.pipe(first()).subscribe((c) => (channel = c!));
    spyOn(channel, 'deleteFile');
    const url = 'http://url/to/file';
    await service.deleteAttachment({
      url,
      type: 'file',
      state: 'success',
      file: {} as any as File,
    });

    expect(channel.deleteFile).toHaveBeenCalledWith(url);
  });

  it('should update #readBy array, if active channel is read', async () => {
    await init();
    let channel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.pipe(first()).subscribe((c) => (channel = c!));
    let latestMessage!: StreamMessage;
    service.activeChannelMessages$.subscribe(
      (messages) => (latestMessage = messages[messages.length - 1])
    );

    expect(latestMessage.readBy.length).toBe(0);

    const user = { id: 'jack', name: 'Jack' } as UserResponse;
    channel.state.read = {
      [user.id]: { last_read: new Date(), user, unread_messages: 0 },
    };
    (channel as MockChannel).handleEvent('message.read', {
      user,
    });

    expect(
      latestMessage.readBy.find((u) => u.id === 'jack')
    ).not.toBeUndefined();
  });

  it(`should unsubscribe from active channel events, after active channel changed`, async () => {
    await init();
    const spy = jasmine.createSpy('activeMessagesSpy');
    service.activeChannelMessages$.subscribe(spy);
    let prevActiveChannel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$
      .pipe(first())
      .subscribe((c) => (prevActiveChannel = c!));
    const newActiveChannel = generateMockChannels()[1];
    service.setAsActiveChannel(newActiveChannel);
    spy.calls.reset();
    (prevActiveChannel as MockChannel).handleEvent('message.new', {
      user: { id: 'jill' },
    });
    (prevActiveChannel as MockChannel).handleEvent('reaction.new', {
      message: mockMessage(),
    });

    expect(spy).not.toHaveBeenCalled();
  });

  it('should query members, less than 100 members', async () => {
    await init();
    const channel = generateMockChannels(1)[0];
    channel.cid = 'new-channel';
    channel.state.members = {
      jack: { user: { id: 'jack', name: 'Jack' } },
      john: { user: { id: 'john' } },
      [user.id]: { user },
    } as any as Record<
      string,
      ChannelMemberResponse<DefaultStreamChatGenerics>
    >;
    service.setAsActiveChannel(channel);
    const result = await service.autocompleteMembers('ja');
    const expectedResult = [
      { user: { id: 'jack', name: 'Jack' } },
      { user: { id: 'john' } },
    ];

    expect(result).toEqual(expectedResult);
  });

  it('should query members, more than 100 members', async () => {
    await init();
    const channel = generateMockChannels(1)[0];
    channel.cid = 'new-channel';
    spyOn(channel, 'queryMembers').and.callThrough();
    const users = Array.from({ length: 101 }, (_, i) => ({ id: `${i}` }));
    channel.state.members = {} as any as Record<
      string,
      ChannelMemberResponse<DefaultStreamChatGenerics>
    >;
    users.forEach((u) => (channel.state.members[u.id] = { user: u }));
    service.setAsActiveChannel(channel);
    const result = await service.autocompleteMembers('ja');

    expect(channel.queryMembers).toHaveBeenCalledWith(
      jasmine.objectContaining({
        name: { $autocomplete: 'ja' },
      })
    );

    expect(result.length).toBe(1);
  });

  it('should select message to be quoted', async () => {
    await init();
    const spy = jasmine.createSpy();
    service.messageToQuote$.subscribe(spy);
    const message = mockMessage();
    service.selectMessageToQuote(message);

    expect(spy).toHaveBeenCalledWith(message);
  });

  it('should deselect message to be quoted', async () => {
    await init();
    const spy = jasmine.createSpy();
    service.messageToQuote$.subscribe(spy);
    service.selectMessageToQuote(undefined);

    expect(spy).toHaveBeenCalledWith(undefined);
  });

  it('should notify channel if typing started', async () => {
    await init();
    let channel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.subscribe((c) => (channel = c!));
    spyOn(channel, 'keystroke');
    await service.typingStarted();

    expect(channel.keystroke).toHaveBeenCalledWith(undefined);
  });

  it('should notify channel if typing stopped', async () => {
    await init();
    let channel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.subscribe((c) => (channel = c!));
    spyOn(channel, 'stopTyping');
    await service.typingStopped();

    expect(channel.stopTyping).toHaveBeenCalledWith(undefined);
  });

  it('should emit users that are currently typing', async () => {
    await init();
    const usersTypingInChannelSpy = jasmine.createSpy();
    const usersTypingInThreadSpy = jasmine.createSpy();
    service.usersTypingInChannel$.subscribe(usersTypingInChannelSpy);
    service.usersTypingInThread$.subscribe((e) => {
      usersTypingInThreadSpy(e);
    });
    let channel!: MockChannel;
    service.activeChannel$.subscribe((c) => (channel = c as MockChannel));
    usersTypingInThreadSpy.calls.reset();
    usersTypingInChannelSpy.calls.reset();
    channel.handleEvent('typing.start', {
      type: 'typing.start',
      user: { id: 'sara' },
    });

    expect(usersTypingInChannelSpy).toHaveBeenCalledWith([{ id: 'sara' }]);
    expect(usersTypingInThreadSpy).not.toHaveBeenCalled();

    usersTypingInThreadSpy.calls.reset();
    usersTypingInChannelSpy.calls.reset();
    channel.handleEvent('typing.start', {
      type: 'typing.start',
      user: { id: 'john' },
    });

    expect(usersTypingInChannelSpy).toHaveBeenCalledWith([
      { id: 'sara' },
      { id: 'john' },
    ]);

    expect(usersTypingInThreadSpy).not.toHaveBeenCalled();

    usersTypingInThreadSpy.calls.reset();
    usersTypingInChannelSpy.calls.reset();
    channel.handleEvent('typing.stop', {
      type: 'typing.stop',
      user: { id: 'sara' },
    });

    expect(usersTypingInChannelSpy).toHaveBeenCalledWith([{ id: 'john' }]);
    expect(usersTypingInThreadSpy).not.toHaveBeenCalled();

    usersTypingInThreadSpy.calls.reset();
    usersTypingInChannelSpy.calls.reset();
    channel.handleEvent('typing.start', {
      type: 'typing.start',
      user,
    });

    expect(usersTypingInChannelSpy).not.toHaveBeenCalled();
    expect(usersTypingInThreadSpy).not.toHaveBeenCalled();
  });

  it('should emit the date of latest messages sent by the user by channels', async () => {
    await init();
    let activeChannel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$
      .pipe(first())
      .subscribe(
        (c) => (activeChannel = c as Channel<DefaultStreamChatGenerics>)
      );
    const newMessage = mockMessage();
    newMessage.cid = 'channel1';
    newMessage.created_at = new Date();
    newMessage.user_id = user.id;
    const spy = jasmine.createSpy();
    service.latestMessageDateByUserByChannels$.subscribe(spy);
    (activeChannel as MockChannel).handleEvent('message.new', {
      message: newMessage,
    });

    expect(spy).toHaveBeenCalledWith({ channel1: newMessage.created_at });
  });

  it('should call custom #customFileUploadRequest and #customImageUploadRequest if provided', async () => {
    await init();
    let channel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.pipe(first()).subscribe((c) => (channel = c!));
    const customImageUploadRequest = jasmine
      .createSpy()
      .and.callFake((file: File) => {
        switch (file.name) {
          case 'file_error.jpg':
            return Promise.reject(new Error());
          default:
            return Promise.resolve({ file: 'http://url/to/image' });
        }
      });
    const customFileUploadRequest = jasmine
      .createSpy()
      .and.callFake((file: File) => {
        switch (file.name) {
          case 'file_error.pdf':
            return Promise.reject(new Error());
          default:
            return Promise.resolve({
              file: 'http://url/to/pdf',
              thumb_url: undefined,
            });
        }
      });
    service.customImageUploadRequest = customImageUploadRequest;
    service.customFileUploadRequest = customFileUploadRequest;
    spyOn(channel, 'sendImage');
    spyOn(channel, 'sendFile');
    const file1 = { name: 'food.png' } as File;
    const file2 = { name: 'file_error.jpg' } as File;
    const file3 = { name: 'menu.pdf' } as File;
    const file4 = { name: 'file_error.pdf' } as File;
    const attachments = [
      { file: file1, type: 'image', state: 'uploading' },
      { file: file2, type: 'image', state: 'uploading' },
      { file: file3, type: 'file', state: 'uploading' },
      { file: file4, type: 'file', state: 'uploading' },
    ] as AttachmentUpload[];
    const result = await service.uploadAttachments(attachments);
    const expectedResult: AttachmentUpload[] = [
      {
        file: file1,
        state: 'success',
        url: 'http://url/to/image',
        type: 'image',
        thumb_url: undefined,
      },
      { file: file2, state: 'error', type: 'image' },
      {
        file: file3,
        state: 'success',
        url: 'http://url/to/pdf',
        type: 'file',
        thumb_url: undefined,
      },
      { file: file4, state: 'error', type: 'file' },
    ];

    expect(channel.sendImage).not.toHaveBeenCalled();
    expect(channel.sendFile).not.toHaveBeenCalled();

    expectedResult.forEach((r, i) => {
      expect(r).toEqual(result[i]);
    });
  });

  it('should call custom #customImageDeleteRequest if provided', async () => {
    await init();
    let channel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.pipe(first()).subscribe((c) => (channel = c!));
    const customImageDeleteRequest = jasmine.createSpy();
    service.customImageDeleteRequest = customImageDeleteRequest;
    spyOn(channel, 'deleteImage');
    const url = 'http://url/to/image';
    await service.deleteAttachment({
      url,
      type: 'image',
      state: 'success',
      file: {} as any as File,
    });

    expect(customImageDeleteRequest).toHaveBeenCalledWith(url, channel);
    expect(channel.deleteImage).not.toHaveBeenCalled();
  });

  it('should call custom #customFileDeleteRequest if provided', async () => {
    await init();
    let channel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.pipe(first()).subscribe((c) => (channel = c!));
    const customFileDeleteRequest = jasmine.createSpy();
    service.customFileDeleteRequest = customFileDeleteRequest;
    spyOn(channel, 'deleteFile');
    const url = 'http://url/to/file';
    await service.deleteAttachment({
      url,
      type: 'file',
      state: 'success',
      file: {} as any as File,
    });

    expect(customFileDeleteRequest).toHaveBeenCalledWith(url, channel);
    expect(channel.deleteFile).not.toHaveBeenCalled();
  });

  it('should reset state after connection recovered', async () => {
    await init();
    mockChatClient.queryChannels.calls.reset();
    events$.next({ eventType: 'connection.recovered' } as ClientEvent);

    expect(mockChatClient.queryChannels).toHaveBeenCalledWith(
      jasmine.any(Object),
      jasmine.any(Object),
      jasmine.any(Object)
    );
  });

  it(`shouldn't do duplicate state reset after connection recovered`, async () => {
    await init();
    mockChatClient.queryChannels.calls.reset();
    events$.next({ eventType: 'connection.recovered' } as ClientEvent);
    events$.next({ eventType: 'connection.recovered' } as ClientEvent);

    expect(mockChatClient.queryChannels).toHaveBeenCalledTimes(1);
  });

  it('should reset pagination options after reconnect', async () => {
    await init(undefined, undefined, { offset: 20 });
    mockChatClient.queryChannels.calls.reset();
    events$.next({ eventType: 'connection.recovered' } as ClientEvent);

    expect(mockChatClient.queryChannels).toHaveBeenCalledWith(
      jasmine.any(Object),
      jasmine.any(Object),
      jasmine.objectContaining({ offset: 0 })
    );
  });

  it('should load message into state', async () => {
    await init();
    const jumpToMessageIdSpy = jasmine.createSpy();
    service.jumpToMessage$.subscribe(jumpToMessageIdSpy);
    jumpToMessageIdSpy.calls.reset();
    const messagesSpy = jasmine.createSpy();
    service.activeChannelMessages$.subscribe(messagesSpy);
    messagesSpy.calls.reset();
    const messageId = '1232121123';
    await service.jumpToMessage(messageId);

    expect(jumpToMessageIdSpy).toHaveBeenCalledWith({
      id: messageId,
      parentId: undefined,
    });

    expect(messagesSpy).toHaveBeenCalledWith(
      jasmine.arrayContaining([jasmine.objectContaining({ id: messageId })])
    );
  });

  it(`should display error notification if message couldn't be loaded`, async () => {
    await init();
    const jumpToMessageIdSpy = jasmine.createSpy();
    service.jumpToMessage$.subscribe(jumpToMessageIdSpy);
    jumpToMessageIdSpy.calls.reset();
    const messagesSpy = jasmine.createSpy();
    service.activeChannelMessages$.subscribe(messagesSpy);
    messagesSpy.calls.reset();
    let activeChannel: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.subscribe((c) => (activeChannel = c!));
    const error = new Error();
    spyOn(activeChannel!.state, 'loadMessageIntoState').and.rejectWith(error);
    const notificationService = TestBed.inject(NotificationService);
    spyOn(notificationService, 'addTemporaryNotification');
    const messageId = '1232121123';
    await expectAsync(service.jumpToMessage(messageId)).toBeRejectedWith(error);

    expect(jumpToMessageIdSpy).not.toHaveBeenCalled();
    expect(messagesSpy).not.toHaveBeenCalled();
    expect(notificationService.addTemporaryNotification).toHaveBeenCalledWith(
      'Message not found'
    );
  });

  it('should pin message', async () => {
    await init();
    const message = mockMessage();
    void service.pinMessage(message);

    expect(mockChatClient.pinMessage).toHaveBeenCalledWith(message);
  });

  it('should display error notification if pinning was unsuccesful', async () => {
    await init();
    const message = mockMessage();
    const notificationService = TestBed.inject(NotificationService);
    spyOn(notificationService, 'addTemporaryNotification').and.callThrough();
    const error = new Error('error');
    mockChatClient.pinMessage.and.rejectWith(error);

    await expectAsync(service.pinMessage(message)).toBeRejectedWith(error);

    expect(notificationService.addTemporaryNotification).toHaveBeenCalledWith(
      'Error pinning message'
    );
  });

  it('should unpin message', async () => {
    await init();
    const message = mockMessage();
    void service.unpinMessage(message);

    expect(mockChatClient.unpinMessage).toHaveBeenCalledWith(message);
  });

  it('should display error notification if unpinning was unsuccesful', async () => {
    await init();
    const message = mockMessage();
    const notificationService = TestBed.inject(NotificationService);
    spyOn(notificationService, 'addTemporaryNotification').and.callThrough();
    const error = new Error('error');
    mockChatClient.unpinMessage.and.rejectWith(error);

    await expectAsync(service.unpinMessage(message)).toBeRejectedWith(error);

    expect(notificationService.addTemporaryNotification).toHaveBeenCalledWith(
      'Error removing message pin'
    );
  });

  it('should deselect active channel if active channel is not present after state reconnect', fakeAsync(async () => {
    await init();
    let activeChannel!: Channel<DefaultStreamChatGenerics>;
    service.activeChannel$.subscribe((c) => (activeChannel = c!));
    let channels!: Channel<DefaultStreamChatGenerics>[];
    service.channels$.subscribe((c) => (channels = c!));
    channels = channels.filter((c) => c.id !== activeChannel.id);
    const spy = jasmine.createSpy();
    service.activeChannel$.subscribe(spy);
    spy.calls.reset();
    mockChatClient.queryChannels.and.resolveTo(channels);
    spyOn(service, 'deselectActiveChannel').and.callThrough();
    events$.next({ eventType: 'connection.recovered' } as ClientEvent);
    tick();

    expect(spy).toHaveBeenCalledWith(undefined);
    expect(service.deselectActiveChannel).toHaveBeenCalledWith();
  }));

  it(`shouldn't deselect active channel if active channel is present after state reconnect`, fakeAsync(async () => {
    await init();
    let channels!: Channel<DefaultStreamChatGenerics>[];
    service.channels$.subscribe((c) => (channels = c!));
    const spy = jasmine.createSpy();
    service.activeChannel$.subscribe(spy);
    spy.calls.reset();
    mockChatClient.queryChannels.and.resolveTo(channels);
    spyOn(service, 'deselectActiveChannel').and.callThrough();
    events$.next({ eventType: 'connection.recovered' } as ClientEvent);
    tick();

    expect(spy).not.toHaveBeenCalled();
    expect(service.deselectActiveChannel).not.toHaveBeenCalled();
  }));

  it('should add new channel to channel list', () => {
    const channelsSpy = jasmine.createSpy();
    service.channels$.subscribe(channelsSpy);
    channelsSpy.calls.reset();

    const newChannel = generateMockChannels(1)[0];
    newChannel.cid = 'my-new-channel';
    spyOn(service as any, 'watchForChannelEvents').and.callThrough();
    service.setAsActiveChannel(newChannel);

    expect(channelsSpy).toHaveBeenCalledWith(
      jasmine.arrayContaining([newChannel])
    );

    //eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect((service as any).watchForChannelEvents).toHaveBeenCalledWith(
      newChannel
    );
  });

  it('should do nothing if same channel is selected twice', () => {
    const activeChannel = generateMockChannels()[0];

    service.setAsActiveChannel(activeChannel);

    const spy = jasmine.createSpy();
    service.activeChannel$.subscribe(spy);
    spy.calls.reset();
    service.setAsActiveChannel(activeChannel);

    expect(spy).not.toHaveBeenCalled();
  });
});
