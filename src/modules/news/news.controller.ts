import { Body, Controller, Get, Headers, HttpException, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ClaimStatus, Role, news, user } from '@prisma/client';
import { BigNumber, TypedDataDomain, ethers } from 'ethers';
import { PaginatedResult } from 'src/_serivces/pagination.service';
import { generateRandom, wordsReadTime } from 'src/_serivces/util.service';
import { Public } from 'src/decorators/public.decorator';
import { Roles } from 'src/decorators/roles.decorator';
import { User } from 'src/decorators/user.decorator';
import { AuthService } from '../auth/services/auth.service';
import { NftStorageService } from '../nft-storage/nft-storage.service';
import { MessageType, OnchainService } from '../onchain/onchain.service';
import {
  ClaimTokenDto,
  ClaimTokenResponseDto,
  CreateNewsInputDto,
  CreateUserClaimNewsDto,
  GetNewsAll,
  UpdateStatusUserClaimNewsDto,
} from './dto/news.dto';
import { NewsService } from './news.service';
import { ConfigService } from '@nestjs/config';
import { DATA_DOMAIN_NAME, DATA_DOMAIN_VERSION, Event } from 'src/constant';
import { Logger, Result } from 'ethers/lib/utils';

// reference: https://restfulapi.net/resource-naming/
@Controller('news')
@ApiTags('News')
export class NewsController {
  private logger = new Logger(NewsController.name);
  constructor(
    private readonly newsService: NewsService,
    private readonly nftStorageService: NftStorageService,
    private readonly onchainService: OnchainService,
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  @ApiBearerAuth()
  @Post('managed-news')
  @Roles([Role.writer])
  async createNews(@User() user: user, @Body() news: CreateNewsInputDto): Promise<news> {
    const content = await this.nftStorageService.getMarkdownFile(news.cid);

    this.logger.info(`Event: ${Event.CreateNewsEvent} - txhash: ${news.txhash}`);

    if (!content) throw new HttpException('CID not found', HttpStatus.BAD_REQUEST);

    let [tokenId, ownerAddress, slug, totalSupply, paymentToken] = await this.onchainService.decodeTxHash(news.txhash);

    news.payment_token = paymentToken;
    news.slug = slug;
    news.content_url = `https://${news.cid}.ipfs.nftstorage.link/`;

    this.logger.info(content, tokenId, ownerAddress, slug, totalSupply, paymentToken);

    return await this.newsService.createNews(news, wordsReadTime(content).wordTime, user, tokenId.toNumber(), totalSupply.toString());
  }
  @Public()
  @Get(':slug')
  async getNewsDetail(@Param('slug') slug: string): Promise<news> {
    const news = await this.newsService.findNewsBySlug(slug);
    if (!news) throw new HttpException('News not found!', HttpStatus.BAD_REQUEST);

    return news;
  }

  @Public()
  @Get('managed-news')
  async getNewsAll(@Query() query: GetNewsAll): Promise<PaginatedResult<any>> {
    const { page, perPage, keyword = '' } = query;
    return await this.newsService.getNewsAll({ page, perPage, keyword });
  }

  // BE của nextJS sẽ gọi API create-claim và truyền vào slug và token của người dùng
  // BE của nextJS có nhiệm vụ tracking việc đọc của người dùng nếu hoàn thành nhiệm vụ thì gọi create-claim
  // nên gửi user token trong thẻ header: x-user-token

  @ApiBearerAuth()
  @Post('managed-claim')
  @Roles([Role.root])
  async createUserClaimNews(@Headers('x-reader-token') readerToken: string, @Body() body: CreateUserClaimNewsDto) {
    if (!readerToken) throw new HttpException("Please add 'x-reader-token' to header", HttpStatus.BAD_REQUEST);

    const user = await this.authService.getUserFromToken(readerToken);
    const news = await this.newsService.findNewsBySlug(body.slug);

    const userClaimNews = await this.newsService.findUserClaimNewsById(user.id, news.id);
    if (userClaimNews) return userClaimNews;

    const transactionId = `transaction#${user.id}_${news.id}_${generateRandom()}`;
    return await this.newsService.createUserClaimNews(transactionId, user.id, news.id);
  }

  @ApiBearerAuth()
  @Put('managed-claim/status')
  @Roles([Role.root])
  async updateStatusUserClaimNews(@Headers('x-reader-token') readerToken: string, @Body() body: UpdateStatusUserClaimNewsDto): Promise<any> {
    if (!readerToken) throw new HttpException("Please add 'x-reader-token' to header", HttpStatus.BAD_REQUEST);

    const user = await this.authService.getUserFromToken(readerToken);
    const news = await this.newsService.findNewsBySlug(body.slug);

    this.logger.info(body.slug, news.id, user.id);

    const userClaimNews = await this.newsService.findUserClaimNewsById(user.id, news.id);
    if (!userClaimNews) throw new HttpException('User Claim News not found!', HttpStatus.BAD_REQUEST);

    console.log(userClaimNews);

    if (userClaimNews.status !== ClaimStatus.pending) throw new HttpException('update status dont have turn!', HttpStatus.BAD_REQUEST);

    this.logger.info(user.id, news.id, body.status);

    return await this.newsService.updateStatusUserClaimNews(user.id, news.id, body.status);
  }

  @ApiBearerAuth()
  @Get('claims')
  @Roles([Role.writer, Role.reader])
  async getListUserClaimNews(@User() user: user): Promise<any> {
    return this.newsService.getListClaimNews(user.id);
  }

  @ApiBearerAuth()
  @Roles([Role.reader])
  @Put('managed-claim')
  async claimToken(@User() user: user, @Body() body: ClaimTokenDto): Promise<ClaimTokenResponseDto> {
    //TODO: check onchain for approve claim news [urgent]
    if (!user.wallet_address) throw new HttpException('Please link wallet!', HttpStatus.BAD_REQUEST);

    const news = await this.newsService.findNewsById(body.news_id);
    if (!news) throw new HttpException('News not found!', HttpStatus.BAD_REQUEST);

    const userClaimNews = await this.newsService.findUserClaimNewsById(user.id, body.news_id);

    if (!userClaimNews || userClaimNews.status === ClaimStatus.failure) throw new HttpException('You not claim token here!', HttpStatus.BAD_REQUEST);

    const domain: TypedDataDomain = {
      name: DATA_DOMAIN_NAME,
      version: DATA_DOMAIN_VERSION,
      verifyingContract: this.configService.get<string>('SNEWS_CONTRACT_ADDRESS'),
    };
    const types = {
      Claim: [
        { name: 'from', type: 'address' },
        { name: 'tokenId', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'value', type: 'uint256' },
      ],
    };

    let userClaimNonce = await this.newsService.countUserClaimNews(user.id);

    const message: MessageType = {
      from: user.wallet_address,
      tokenId: news.token_id,
      nonce: userClaimNonce + 1,
      value: ethers.utils.parseEther(news.total_supply),
    };
    let signMessage = await this.onchainService.signMessage(domain, types, message);

    await this.newsService.updateStatusUserClaimNews(user.id, news.id, ClaimStatus.success);

    return {
      r: signMessage.r,
      v: signMessage.v,
      s: signMessage.s,
      transaction_id: userClaimNews.transaction_id,
      slug: news.slug,
    };
  }
}
